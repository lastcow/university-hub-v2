// Grades CRUD with FERPA record-of-access logging (epic UNI-21 / sub-issue
// UNI-30).
//
//   GET    /api/courses/:id/grades         course gradebook
//                                            (faculty / teacher / TA on course)
//   GET    /api/students/:id/grades        student-self OR faculty teaching
//                                            a course they're in
//   POST   /api/grades                     faculty / teacher (record grade)
//   PATCH  /api/grades/:id                 faculty / teacher (change grade)
//
// Every read writes to `grade_access_log` (FERPA record-of-disclosure).
// Every mutation writes to both `audit_logs` (operational audit, with from/to
// in metadata) AND `grade_access_log` (because a write implies a disclosure
// to the grader of the prior value).

import {
  createGradeInputSchema,
  updateGradeInputSchema,
  type Grade,
  type GradebookEntry,
  type GradeStatus,
  type Role,
  type StudentGradeEntry,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import {
  CourseScopeError,
  assertActorOnCourse,
  courseScopeErrorResponse,
  isCourseScopedRole,
  toActor,
  type ResolvedAssignmentRole,
} from "../db/scoped.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import {
  writeGradeAccessLog,
  writeGradeAccessLogBatch,
  type GradeAccessContext,
} from "../services/grade-access-log.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type GradeRow = Row & {
  id: string;
  assessment_id: string;
  student_user_id: string;
  score: number | null;
  letter_grade: string | null;
  feedback: string | null;
  status: GradeStatus;
  graded_by_user_id: string | null;
  graded_at: string | null;
  created_at: string;
  updated_at: string;
};

type GradebookRow = GradeRow & {
  student_name: string;
  student_email: string;
  assessment_title: string;
  assessment_max_score: number;
  course_id: string;
};

type StudentGradeRow = GradebookRow & {
  course_name: string | null;
  course_code: string | null;
  assessment_weight: number;
  assessment_due_at: string | null;
};

type AssessmentLookupRow = Row & {
  id: string;
  course_id: string;
  course_university_id: string | null;
  deleted_at: string | null;
};

type GradeLookupRow = GradeRow & {
  assessment_course_id: string;
  course_university_id: string | null;
};

const SELECT_GRADE_BASE = `
  SELECT g.id, g.assessment_id, g.student_user_id, g.score, g.letter_grade,
         g.feedback, g.status, g.graded_by_user_id, g.graded_at,
         g.created_at, g.updated_at
    FROM grades g
`;

function toGrade(row: GradeRow): Grade {
  return {
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
  };
}

function toGradebookEntry(row: GradebookRow): GradebookEntry {
  return {
    ...toGrade(row),
    student_name: row.student_name,
    student_email: row.student_email,
    assessment_title: row.assessment_title,
    assessment_max_score: Number(row.assessment_max_score),
    course_id: row.course_id,
  };
}

function toStudentGradeEntry(row: StudentGradeRow): StudentGradeEntry {
  return {
    ...toGradebookEntry(row),
    course_name: row.course_name,
    course_code: row.course_code,
    assessment_weight: Number(row.assessment_weight),
    assessment_due_at: row.assessment_due_at,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function loadAssessment(
  db: D1Database,
  assessmentId: string,
): Promise<AssessmentLookupRow | null> {
  return queryFirst<AssessmentLookupRow>(
    db,
    `SELECT a.id, a.course_id, a.deleted_at,
            c.university_id AS course_university_id
       FROM assessments a
       LEFT JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? LIMIT 1`,
    [assessmentId],
  );
}

async function loadGrade(
  db: D1Database,
  gradeId: string,
): Promise<GradeLookupRow | null> {
  return queryFirst<GradeLookupRow>(
    db,
    `SELECT g.id, g.assessment_id, g.student_user_id, g.score, g.letter_grade,
            g.feedback, g.status, g.graded_by_user_id, g.graded_at,
            g.created_at, g.updated_at,
            a.course_id AS assessment_course_id,
            c.university_id AS course_university_id
       FROM grades g
       LEFT JOIN assessments a ON a.id = g.assessment_id
       LEFT JOIN courses c ON c.id = a.course_id
       WHERE g.id = ? LIMIT 1`,
    [gradeId],
  );
}

function resolvedToCourseRole(role: ResolvedAssignmentRole): string {
  return role;
}

// ---------------------------------------------------------------------------
// GET /api/courses/:id/grades
//
// Course gradebook. Faculty / teacher / TA on the course (or admins) see one
// row per (assessment, student in the course). Every row read emits a
// `grade_access_log` entry.
// ---------------------------------------------------------------------------

export async function handleListCourseGrades(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Course-scoped read: faculty / teacher / TA must be assigned. Admins
  // bypass via the helper. Anyone else (student, staff, viewer) gets 404.
  let viewerCourseRole: ResolvedAssignmentRole = "admin";
  if (isCourseScopedRole(actor.role)) {
    try {
      const result = await assertActorOnCourse(
        ctx.env.DB,
        toActor(actor),
        courseId,
      );
      viewerCourseRole = result.assignmentRole;
    } catch (err) {
      if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
      throw err;
    }
  } else if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin"
  ) {
    return errorResponse(404, "not_found", "Course not found.");
  } else {
    // Admin: confirm the course exists and (for university_admin) shares the
    // university.
    const course = await queryFirst<{ university_id: string } & Row>(
      ctx.env.DB,
      `SELECT university_id FROM courses WHERE id = ? LIMIT 1`,
      [courseId],
    );
    if (
      !course ||
      (actor.role === "university_admin" &&
        course.university_id !== actor.university_id)
    ) {
      return errorResponse(404, "not_found", "Course not found.");
    }
  }

  const rows = await queryAll<GradebookRow>(
    ctx.env.DB,
    `SELECT g.id, g.assessment_id, g.student_user_id, g.score, g.letter_grade,
            g.feedback, g.status, g.graded_by_user_id, g.graded_at,
            g.created_at, g.updated_at,
            u.name AS student_name, u.email AS student_email,
            a.title AS assessment_title, a.max_score AS assessment_max_score,
            a.course_id AS course_id
       FROM grades g
       JOIN assessments a ON a.id = g.assessment_id
       JOIN users u ON u.id = g.student_user_id
       WHERE a.course_id = ? AND a.deleted_at IS NULL
       ORDER BY a.due_at IS NULL, a.due_at ASC, u.name ASC
       LIMIT 1000`,
    [courseId],
  );

  // FERPA: one log row per disclosed grade.
  await writeGradeAccessLogBatch(
    ctx.env.DB,
    rows.map((row) => ({
      viewerUserId: actor.id,
      viewerRole: actor.role,
      viewerCourseRole: resolvedToCourseRole(viewerCourseRole),
      courseId,
      assessmentId: row.assessment_id,
      viewedGradeId: row.id,
      viewedStudentUserId: row.student_user_id,
      context: "course_gradebook" satisfies GradeAccessContext,
    })),
  );

  return jsonOk(rows.map(toGradebookEntry));
}

// ---------------------------------------------------------------------------
// GET /api/students/:id/grades
//
// Student-self view OR faculty teaching a course the student is enrolled in.
// (Admins also pass — university_admin within the same university,
// super_admin always.)
//
// We emit one `grade_access_log` row per disclosed grade, with the context
// distinguishing student-self from faculty-view-of-other.
// ---------------------------------------------------------------------------

export async function handleListStudentGrades(
  ctx: RequestContext,
  studentUserId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // The viewing student must be the same user. Anyone else needs a teaching
  // role on a course the student is in (or admin bypass).
  const isSelf = actor.id === studentUserId;
  if (!isSelf) {
    if (
      actor.role !== "super_admin" &&
      actor.role !== "university_admin" &&
      actor.role !== "faculty" &&
      actor.role !== "teacher" &&
      actor.role !== "teacher_assistant"
    ) {
      return errorResponse(404, "not_found", "Student not found.");
    }
  }

  const studentRow = await queryFirst<{
    id: string;
    role: Role;
    university_id: string | null;
  } & Row>(
    ctx.env.DB,
    `SELECT id, role, university_id FROM users WHERE id = ? LIMIT 1`,
    [studentUserId],
  );
  if (!studentRow || studentRow.role !== "student") {
    return errorResponse(404, "not_found", "Student not found.");
  }

  // Cross-university actors are never allowed (defense in depth).
  if (
    !isSelf &&
    actor.role !== "super_admin" &&
    actor.university_id !== null &&
    actor.university_id !== studentRow.university_id
  ) {
    return errorResponse(404, "not_found", "Student not found.");
  }

  // Find the (course, assignmentRole) tuples that authorize this read.
  // Self: every course they're enrolled in.
  // Admin: every course in shared university.
  // Faculty/teacher/TA: courses where they are assigned AND the student is
  // enrolled.
  type CourseTuple = { course_id: string; viewerCourseRole: string };
  let courseTuples: CourseTuple[] = [];
  if (isSelf) {
    const rows = await queryAll<{ course_id: string } & Row>(
      ctx.env.DB,
      `SELECT DISTINCT course_id FROM course_assignments
         WHERE user_id = ? AND role = 'student'`,
      [studentUserId],
    );
    courseTuples = rows.map((r) => ({
      course_id: r.course_id,
      viewerCourseRole: "student",
    }));
  } else if (actor.role === "super_admin" || actor.role === "university_admin") {
    const rows = await queryAll<{ course_id: string } & Row>(
      ctx.env.DB,
      `SELECT DISTINCT ca.course_id
         FROM course_assignments ca
         JOIN courses c ON c.id = ca.course_id
         WHERE ca.user_id = ? AND ca.role = 'student'
           AND (? = 'super_admin' OR c.university_id = ?)`,
      [studentUserId, actor.role, actor.university_id ?? ""],
    );
    courseTuples = rows.map((r) => ({
      course_id: r.course_id,
      viewerCourseRole: "admin",
    }));
  } else {
    const rows = await queryAll<{ course_id: string; role: string } & Row>(
      ctx.env.DB,
      `SELECT teaching.course_id AS course_id, teaching.role AS role
         FROM course_assignments teaching
         JOIN course_assignments enrolled
           ON enrolled.course_id = teaching.course_id
          AND enrolled.user_id = ?
          AND enrolled.role = 'student'
         WHERE teaching.user_id = ?
           AND teaching.role IN ('faculty','teacher','teacher_assistant')`,
      [studentUserId, actor.id],
    );
    courseTuples = rows.map((r) => ({
      course_id: r.course_id,
      viewerCourseRole: r.role,
    }));
  }

  if (courseTuples.length === 0) {
    if (isSelf) {
      return jsonOk([]);
    }
    return errorResponse(404, "not_found", "Student not found.");
  }

  // Pull the actual grade rows for those courses.
  const courseIds = courseTuples.map((t) => t.course_id);
  const placeholders = courseIds.map(() => "?").join(",");
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
         AND a.course_id IN (${placeholders})
       ORDER BY c.name ASC, a.due_at IS NULL, a.due_at ASC, a.title ASC`,
    [studentUserId, ...courseIds],
  );

  const courseRoleByCourse = new Map(
    courseTuples.map((t) => [t.course_id, t.viewerCourseRole]),
  );

  await writeGradeAccessLogBatch(
    ctx.env.DB,
    rows.map((row) => ({
      viewerUserId: actor.id,
      viewerRole: actor.role,
      viewerCourseRole: courseRoleByCourse.get(row.course_id) ?? null,
      courseId: row.course_id,
      assessmentId: row.assessment_id,
      viewedGradeId: row.id,
      viewedStudentUserId: studentUserId,
      context: (isSelf
        ? "student_self"
        : "student_view_by_faculty") satisfies GradeAccessContext,
    })),
  );

  return jsonOk(rows.map(toStudentGradeEntry));
}

// ---------------------------------------------------------------------------
// POST /api/grades
// ---------------------------------------------------------------------------

export async function handleCreateGrade(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty" &&
    actor.role !== "teacher"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Only faculty or teachers can record grades.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = createGradeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid grade payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const assessment = await loadAssessment(ctx.env.DB, parsed.data.assessment_id);
  if (!assessment || assessment.deleted_at) {
    return errorResponse(404, "not_found", "Assessment not found.");
  }

  let universityId: string | null = assessment.course_university_id;
  let viewerCourseRole: ResolvedAssignmentRole = "admin";
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      assessment.course_id,
      ["faculty", "teacher"],
    );
    universityId = result.universityId;
    viewerCourseRole = result.assignmentRole;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  // The student must be enrolled in the same course.
  const enrollment = await queryFirst<{ id: string } & Row>(
    ctx.env.DB,
    `SELECT id FROM course_assignments
       WHERE course_id = ? AND user_id = ? AND role = ?
       LIMIT 1`,
    [assessment.course_id, parsed.data.student_user_id, "student"],
  );
  if (!enrollment) {
    return errorResponse(
      400,
      "invalid_student",
      "Student is not enrolled in this course.",
    );
  }

  // Reject duplicate (assessment, student) — UNIQUE index would reject too,
  // but a clean 409 is friendlier than an opaque 500.
  const dupe = await queryFirst<{ id: string } & Row>(
    ctx.env.DB,
    `SELECT id FROM grades WHERE assessment_id = ? AND student_user_id = ? LIMIT 1`,
    [parsed.data.assessment_id, parsed.data.student_user_id],
  );
  if (dupe) {
    return errorResponse(
      409,
      "grade_exists",
      "A grade already exists for this student on this assessment. Use PATCH to update it.",
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status: GradeStatus = parsed.data.status ?? "graded";
  const score = parsed.data.score ?? null;
  const letter = parsed.data.letter_grade ?? null;
  const feedback = parsed.data.feedback ?? null;
  const gradedAt = status === "graded" ? now : null;

  await execute(
    ctx.env.DB,
    `INSERT INTO grades
       (id, assessment_id, student_user_id, score, letter_grade, feedback,
        status, graded_by_user_id, graded_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.assessment_id,
      parsed.data.student_user_id,
      score,
      letter,
      feedback,
      status,
      actor.id,
      gradedAt,
      now,
      now,
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "grade.created",
    actorUserId: actor.id,
    universityId,
    entityType: "grade",
    entityId: id,
    metadata: {
      assessment_id: parsed.data.assessment_id,
      course_id: assessment.course_id,
      student_user_id: parsed.data.student_user_id,
      to: { score, letter_grade: letter, status },
    },
  });

  // Disclosure: the grader has now seen the student's (new) grade.
  await writeGradeAccessLog(ctx.env.DB, {
    viewerUserId: actor.id,
    viewerRole: actor.role,
    viewerCourseRole: resolvedToCourseRole(viewerCourseRole),
    courseId: assessment.course_id,
    assessmentId: parsed.data.assessment_id,
    viewedGradeId: id,
    viewedStudentUserId: parsed.data.student_user_id,
    context: "course_gradebook",
  });

  const row = await queryFirst<GradeRow>(
    ctx.env.DB,
    `${SELECT_GRADE_BASE} WHERE g.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not record grade.");
  }
  return jsonOk(toGrade(row), { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH /api/grades/:id
// ---------------------------------------------------------------------------

export async function handleUpdateGrade(
  ctx: RequestContext,
  gradeId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty" &&
    actor.role !== "teacher"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Only faculty or teachers can update grades.",
    );
  }

  const existing = await loadGrade(ctx.env.DB, gradeId);
  if (!existing) {
    return errorResponse(404, "not_found", "Grade not found.");
  }

  let universityId: string | null = existing.course_university_id;
  let viewerCourseRole: ResolvedAssignmentRole = "admin";
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      existing.assessment_course_id,
      ["faculty", "teacher"],
    );
    universityId = result.universityId;
    viewerCourseRole = result.assignmentRole;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const raw = await readJson(ctx.request);
  const parsed = updateGradeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid grade payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  if (parsed.data.score !== undefined) {
    const next = parsed.data.score ?? null;
    const prev = existing.score === null ? null : Number(existing.score);
    if (next !== prev) {
      updates.push("score = ?");
      params.push(next);
      changed.score = { from: prev, to: next };
    }
  }
  if (parsed.data.letter_grade !== undefined) {
    const next = parsed.data.letter_grade ?? null;
    if (next !== existing.letter_grade) {
      updates.push("letter_grade = ?");
      params.push(next);
      changed.letter_grade = { from: existing.letter_grade, to: next };
    }
  }
  if (parsed.data.feedback !== undefined) {
    const next = parsed.data.feedback ?? null;
    if (next !== existing.feedback) {
      updates.push("feedback = ?");
      params.push(next);
      changed.feedback = { from: existing.feedback, to: next };
    }
  }
  if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
    updates.push("status = ?");
    params.push(parsed.data.status);
    changed.status = { from: existing.status, to: parsed.data.status };
  }

  if (updates.length === 0) {
    // No-op update — still log the disclosure (the grader saw the row to
    // decide it didn't need changing) but skip the audit row.
    await writeGradeAccessLog(ctx.env.DB, {
      viewerUserId: actor.id,
      viewerRole: actor.role,
      viewerCourseRole: resolvedToCourseRole(viewerCourseRole),
      courseId: existing.assessment_course_id,
      assessmentId: existing.assessment_id,
      viewedGradeId: existing.id,
      viewedStudentUserId: existing.student_user_id,
      context: "course_gradebook",
    });
    return jsonOk(toGrade(existing));
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  updates.push("graded_by_user_id = ?");
  params.push(actor.id);
  if (
    parsed.data.status === "graded" ||
    (parsed.data.status === undefined && existing.status === "graded")
  ) {
    updates.push("graded_at = ?");
    params.push(now);
  }

  await execute(
    ctx.env.DB,
    `UPDATE grades SET ${updates.join(", ")} WHERE id = ?`,
    [...params, gradeId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "grade.changed",
    actorUserId: actor.id,
    universityId,
    entityType: "grade",
    entityId: gradeId,
    metadata: {
      assessment_id: existing.assessment_id,
      course_id: existing.assessment_course_id,
      student_user_id: existing.student_user_id,
      changed,
    },
  });

  await writeGradeAccessLog(ctx.env.DB, {
    viewerUserId: actor.id,
    viewerRole: actor.role,
    viewerCourseRole: resolvedToCourseRole(viewerCourseRole),
    courseId: existing.assessment_course_id,
    assessmentId: existing.assessment_id,
    viewedGradeId: existing.id,
    viewedStudentUserId: existing.student_user_id,
    context: "course_gradebook",
  });

  const next = await queryFirst<GradeRow>(
    ctx.env.DB,
    `${SELECT_GRADE_BASE} WHERE g.id = ? LIMIT 1`,
    [gradeId],
  );
  if (!next) {
    return errorResponse(500, "update_failed", "Could not update grade.");
  }
  return jsonOk(toGrade(next));
}
