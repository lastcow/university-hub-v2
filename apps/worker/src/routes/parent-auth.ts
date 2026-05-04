// Parent / guardian sign-in surface (epic UNI-21 / sub-issue UNI-32).
//
//   POST /api/parent/sign-in/request  { parent_email }
//   POST /api/parent/sign-in/verify   { parent_email, token }
//   POST /api/parent/sign-out
//   GET  /api/parent/me
//   GET  /api/parent/grades           — read-only access to the bound
//                                       student's grades, FERPA-logged.
//
// The parent never has a `users` row. `parent_sessions` ties a verified
// parent_email to one student_user_id. Cross-student access is impossible
// at the data layer because every parent endpoint scopes by the session's
// student.

import {
  parentSignInRequestInputSchema,
  parentSignInVerifyInputSchema,
  type ParentMe,
  type ParentSignInRequestResponse,
  type ParentSignInVerifyResponse,
  type StudentGradeEntry,
} from "@university-hub/shared";

import {
  consumeParentToken,
  createParentSession,
  deleteParentSessionByToken,
  findUnder18StudentsByParentEmail,
  issueParentToken,
  PARENT_SESSION_COOKIE,
  resolveParentSession,
  type ParentSessionRow,
  type ParentStudentLookup,
} from "../auth/parent-session.js";
import { queryAll, type Row } from "../db/index.js";
import type { Env } from "../env.js";
import { sendParentSignInEmail } from "../mail/index.js";
import {
  byEmail,
  byIp,
  clientIpFromCtx,
  rateLimitedResponse,
  signInLimit,
} from "../middleware/rate-limit.js";
import type { RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import {
  writeGradeAccessLogBatch,
  type GradeAccessLogInput,
} from "../services/grade-access-log.js";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
} from "../utils/cookies.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const PARENT_REQUEST_GENERIC: ParentSignInRequestResponse = {
  ok: true,
  message:
    "If a parent or guardian email matches a student in our records, a sign-in link is on the way.",
};

// ---------------------------------------------------------------------------
// POST /api/parent/sign-in/request
// ---------------------------------------------------------------------------

export async function handleParentSignInRequest(
  ctx: RequestContext,
): Promise<Response> {
  const ip = clientIpFromCtx(ctx);

  // IP rate-limit BEFORE we read the body so a flood from one host can't
  // drown the DB.
  const ipOutcome = await byIp(
    ctx.env,
    "parent.sign_in_request",
    ip,
    signInLimit(ctx.env),
  );
  if (!ipOutcome.allowed) {
    return rateLimitedResponse(
      ipOutcome,
      "Too many sign-in attempts from this address. Try again in a few minutes.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = parentSignInRequestInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid sign-in request.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const { parent_email } = parsed.data;

  const emailOutcome = await byEmail(
    ctx.env,
    "parent.sign_in_request_email",
    parent_email,
    signInLimit(ctx.env),
  );
  if (!emailOutcome.allowed) {
    return rateLimitedResponse(
      emailOutcome,
      "Too many sign-in attempts for that address. Try again later.",
    );
  }

  const matches = await findUnder18StudentsByParentEmail(
    ctx.env.DB,
    parent_email,
  );

  // Always 202; we never disclose whether the email matches a student.
  for (const match of matches) {
    const issued = await issueParentToken(ctx.env.DB, {
      studentUserId: match.user_id,
      parentEmail: parent_email,
    });

    await sendParentSignInEmail(ctx.env, {
      to: parent_email,
      universityId: match.university_id,
      relatedEntity: { type: "parent_token", id: issued.id },
      variables: {
        parent_email,
        student_name: match.name,
        sign_in_url: parentSignInUrl(ctx.env, parent_email, issued.token),
        token: issued.token,
        expires_minutes: 15,
      },
    });

    await writeAuditLog(ctx.env.DB, {
      action: "parent.sign_in_requested",
      actorUserId: null,
      universityId: match.university_id,
      entityType: "parent_token",
      entityId: issued.id,
      metadata: {
        student_user_id: match.user_id,
        parent_email,
        ip,
      },
    });
  }

  return jsonOk(PARENT_REQUEST_GENERIC, { status: 202 });
}

function parentSignInUrl(env: Env, email: string, token: string): string {
  const base = (env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const params = new URLSearchParams({ parent_email: email, token });
  return `${base}/sign-in/parent?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// POST /api/parent/sign-in/verify
// ---------------------------------------------------------------------------

export async function handleParentSignInVerify(
  ctx: RequestContext,
): Promise<Response> {
  const ip = clientIpFromCtx(ctx);
  const ipOutcome = await byIp(
    ctx.env,
    "parent.sign_in_verify",
    ip,
    signInLimit(ctx.env),
  );
  if (!ipOutcome.allowed) {
    return rateLimitedResponse(
      ipOutcome,
      "Too many verification attempts. Try again in a few minutes.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = parentSignInVerifyInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid verify request.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const { parent_email, token } = parsed.data;

  const consumed = await consumeParentToken(ctx.env.DB, parent_email, token);
  if (!consumed) {
    return errorResponse(
      401,
      "invalid_token",
      "That sign-in link is invalid or has expired. Request a new one.",
    );
  }

  // Re-confirm the student is still under 18 + the parent email still
  // matches — these can change between request and verify (rare, but the
  // consequences are large enough that we double-check).
  const student = await loadStudentSummary(ctx.env, consumed.student_user_id);
  if (
    !student ||
    !student.under_18 ||
    student.parent_guardian_email !== parent_email
  ) {
    return errorResponse(
      401,
      "invalid_token",
      "That sign-in link is no longer valid. Request a new one.",
    );
  }

  const created = await createParentSession(ctx.env.DB, {
    studentUserId: student.user_id,
    parentEmail: parent_email,
  });

  await writeAuditLog(ctx.env.DB, {
    action: "parent.sign_in_verified",
    actorUserId: null,
    universityId: student.university_id,
    entityType: "parent_session",
    entityId: created.id,
    metadata: {
      student_user_id: student.user_id,
      parent_email,
      ip,
    },
  });

  const setCookie = buildSessionSetCookie(ctx.env, {
    name: PARENT_SESSION_COOKIE,
    value: created.token,
    expires: created.expiresAt,
  });

  const body: ParentSignInVerifyResponse = {
    ok: true,
    parent: toParentMe(student, parent_email, created.expiresAt.toISOString()),
  };
  return jsonOk(body, { headers: { "set-cookie": setCookie } });
}

// ---------------------------------------------------------------------------
// POST /api/parent/sign-out
// ---------------------------------------------------------------------------

export async function handleParentSignOut(
  ctx: RequestContext,
): Promise<Response> {
  const token = ctx.cookies[PARENT_SESSION_COOKIE];
  if (token) {
    const session = await resolveParentSession(ctx.env.DB, token);
    await deleteParentSessionByToken(ctx.env.DB, token);
    if (session) {
      await writeAuditLog(ctx.env.DB, {
        action: "parent.sign_out",
        actorUserId: null,
        universityId: null,
        entityType: "parent_session",
        entityId: session.id,
        metadata: {
          student_user_id: session.student_user_id,
          parent_email: session.parent_email,
        },
      });
    }
  }
  const clear = buildSessionClearCookie(ctx.env, PARENT_SESSION_COOKIE);
  return jsonOk({ ok: true } as const, { headers: { "set-cookie": clear } });
}

// ---------------------------------------------------------------------------
// Resolve parent session — internal helper used by all read endpoints below.
// ---------------------------------------------------------------------------

interface ResolvedParentSession {
  session: ParentSessionRow;
  student: ParentStudentLookup;
}

async function requireParentAuth(
  ctx: RequestContext,
): Promise<ResolvedParentSession | Response> {
  const token = ctx.cookies[PARENT_SESSION_COOKIE];
  if (!token) {
    return errorResponse(
      401,
      "unauthenticated",
      "Parent authentication required.",
    );
  }
  const session = await resolveParentSession(ctx.env.DB, token);
  if (!session) {
    return errorResponse(
      401,
      "unauthenticated",
      "Your parent sign-in has expired. Please sign in again.",
    );
  }
  const student = await loadStudentSummary(ctx.env, session.student_user_id);
  if (
    !student ||
    !student.under_18 ||
    student.parent_guardian_email !== session.parent_email
  ) {
    // Defensive — the binding has changed (student turned 18, parent email
    // updated). Drop the session and force re-auth.
    await deleteParentSessionByToken(ctx.env.DB, token);
    return errorResponse(
      401,
      "unauthenticated",
      "Your parent sign-in is no longer valid.",
    );
  }
  return { session, student };
}

async function loadStudentSummary(
  env: Env,
  studentUserId: string,
): Promise<ParentStudentLookup | null> {
  const rows = await queryAll<ParentStudentLookup & Row>(
    env.DB,
    `SELECT s.id AS student_id, s.user_id AS user_id, s.university_id AS university_id,
            s.parent_guardian_email AS parent_guardian_email, s.under_18 AS under_18,
            u.name AS name, u.email AS email,
            un.name AS university_name
       FROM students s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN universities un ON un.id = s.university_id
       WHERE s.user_id = ?`,
    [studentUserId],
  );
  return rows[0] ?? null;
}

function toParentMe(
  student: ParentStudentLookup,
  parentEmail: string,
  expiresAt: string,
): ParentMe {
  return {
    parent_email: parentEmail,
    expires_at: expiresAt,
    student: {
      student_id: student.student_id,
      student_user_id: student.user_id,
      name: student.name,
      email: student.email,
      university_id: student.university_id,
      university_name: student.university_name,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/parent/me
// ---------------------------------------------------------------------------

export async function handleParentMe(ctx: RequestContext): Promise<Response> {
  const auth = await requireParentAuth(ctx);
  if (auth instanceof Response) return auth;
  const body: ParentMe = toParentMe(
    auth.student,
    auth.session.parent_email,
    auth.session.expires_at,
  );
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// GET /api/parent/grades — bound student's grades, FERPA-logged
//
// The query mirrors `/api/students/:id/grades` for the same student id; we
// re-implement here rather than delegate so we don't have to thread the
// non-`Role` viewer through grades.ts. Every disclosed row writes a
// `grade_access_log` entry with `viewer_role: 'parent'`.
// ---------------------------------------------------------------------------

interface StudentGradeRow extends Row {
  id: string;
  assessment_id: string;
  student_user_id: string;
  score: number | null;
  letter_grade: string | null;
  feedback: string | null;
  status: "graded" | "pending" | "excused";
  graded_by_user_id: string | null;
  graded_at: string | null;
  created_at: string;
  updated_at: string;
  student_name: string;
  student_email: string;
  assessment_title: string;
  assessment_max_score: number;
  assessment_weight: number;
  assessment_due_at: string | null;
  course_id: string;
  course_name: string | null;
  course_code: string | null;
}

export async function handleParentGrades(
  ctx: RequestContext,
): Promise<Response> {
  const auth = await requireParentAuth(ctx);
  if (auth instanceof Response) return auth;
  const { student } = auth;

  const rows = await queryAll<StudentGradeRow>(
    ctx.env.DB,
    `SELECT g.id, g.assessment_id, g.student_user_id, g.score, g.letter_grade,
            g.feedback, g.status, g.graded_by_user_id, g.graded_at,
            g.created_at, g.updated_at,
            u.name AS student_name, u.email AS student_email,
            a.title AS assessment_title, a.max_score AS assessment_max_score,
            a.weight AS assessment_weight, a.due_at AS assessment_due_at,
            a.course_id AS course_id,
            c.name AS course_name, c.code AS course_code
       FROM grades g
       JOIN assessments a ON a.id = g.assessment_id
       JOIN users u ON u.id = g.student_user_id
       LEFT JOIN courses c ON c.id = a.course_id
       WHERE g.student_user_id = ?
         AND a.deleted_at IS NULL
       ORDER BY c.name ASC, a.due_at IS NULL, a.due_at ASC, a.title ASC`,
    [student.user_id],
  );

  // FERPA: every disclosed row writes one access log entry. Parent is not a
  // Role — the underlying column is TEXT so we cast safely.
  const accessRows: GradeAccessLogInput[] = rows.map((row) => ({
    viewerUserId: null,
    viewerRole: "parent" as unknown as GradeAccessLogInput["viewerRole"],
    viewerCourseRole: "parent",
    courseId: row.course_id,
    assessmentId: row.assessment_id,
    viewedGradeId: row.id,
    viewedStudentUserId: student.user_id,
    context: "student_view_by_faculty",
  }));
  await writeGradeAccessLogBatch(ctx.env.DB, accessRows);

  const body: StudentGradeEntry[] = rows.map((row) => ({
    id: row.id,
    assessment_id: row.assessment_id,
    student_user_id: row.student_user_id,
    score: row.score === null ? null : Number(row.score),
    letter_grade: row.letter_grade,
    feedback: row.feedback,
    status: row.status,
    graded_by_user_id: row.graded_by_user_id,
    graded_at: row.graded_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    student_name: row.student_name,
    student_email: row.student_email,
    assessment_title: row.assessment_title,
    assessment_max_score: Number(row.assessment_max_score),
    course_id: row.course_id,
    course_name: row.course_name,
    course_code: row.course_code,
    assessment_weight: Number(row.assessment_weight),
    assessment_due_at: row.assessment_due_at,
  }));
  return jsonOk(body);
}
