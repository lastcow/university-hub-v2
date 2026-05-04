// Assessments CRUD (epic UNI-21 / sub-issue UNI-30).
//
//   GET    /api/courses/:id/assessments     list (faculty/teacher/TA assigned
//                                           to course OR student in course)
//   POST   /api/courses/:id/assessments     create (faculty only)
//   PATCH  /api/assessments/:id             update (faculty only)
//   DELETE /api/assessments/:id             soft-delete (faculty only)
//
// All access goes through the per-course scoping helper from sub-issue UNI-22
// (`assertActorOnCourse`) — a wrong-course actor fails at the query layer.
// "Faculty only" for write endpoints is enforced via the helper's
// `allowedCourseRoles: ["faculty"]` option (admins still bypass).
//
// Reads do NOT write to `grade_access_log` — assessments themselves don't
// disclose grades, only the metadata (title / weight / due date). Grade
// reads are logged in the grades route.

import {
  createAssessmentInputSchema,
  updateAssessmentInputSchema,
  type Assessment,
  type AssessmentListItem,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import {
  CourseScopeError,
  assertActorOnCourse,
  courseScopeErrorResponse,
  isCourseScopedRole,
  toActor,
} from "../db/scoped.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type AssessmentRow = Row & {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  weight: number;
  max_score: number;
  due_at: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type AssessmentListRow = AssessmentRow & {
  course_name: string | null;
  course_code: string | null;
  course_university_id: string | null;
};

const SELECT_ASSESSMENT_BASE = `
  SELECT a.id, a.course_id, a.title, a.description, a.weight, a.max_score,
         a.due_at, a.created_by, a.deleted_at, a.created_at, a.updated_at,
         c.name AS course_name, c.code AS course_code,
         c.university_id AS course_university_id
    FROM assessments a
    LEFT JOIN courses c ON c.id = a.course_id
`;

function toAssessment(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    course_id: row.course_id,
    title: row.title,
    description: row.description,
    weight: Number(row.weight),
    max_score: Number(row.max_score),
    due_at: row.due_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAssessmentListItem(row: AssessmentListRow): AssessmentListItem {
  return {
    ...toAssessment(row),
    course_name: row.course_name,
    course_code: row.course_code,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function isStudentInCourse(
  db: D1Database,
  courseId: string,
  userId: string,
): Promise<boolean> {
  const row = await queryFirst<{ id: string } & Row>(
    db,
    `SELECT id FROM course_assignments
       WHERE course_id = ? AND user_id = ? AND role = ?
       LIMIT 1`,
    [courseId, userId, "student"],
  );
  return row !== null;
}

async function loadAssessment(
  db: D1Database,
  id: string,
): Promise<AssessmentListRow | null> {
  return queryFirst<AssessmentListRow>(
    db,
    `${SELECT_ASSESSMENT_BASE} WHERE a.id = ? LIMIT 1`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// GET /api/courses/:id/assessments
// ---------------------------------------------------------------------------

export async function handleListAssessments(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Course-scoped roles must be assigned to the course in any teaching role.
  // Students must be assigned in the `student` role (read-only). Admins
  // bypass the helper.
  if (isCourseScopedRole(actor.role)) {
    try {
      await assertActorOnCourse(ctx.env.DB, toActor(actor), courseId);
    } catch (err) {
      if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
      throw err;
    }
  } else if (actor.role === "student") {
    if (!(await isStudentInCourse(ctx.env.DB, courseId, actor.id))) {
      return errorResponse(404, "not_found", "Course not found.");
    }
  } else if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "staff"
  ) {
    return errorResponse(404, "not_found", "Course not found.");
  } else {
    // university_admin / staff: must share the course's university.
    const course = await queryFirst<{ university_id: string } & Row>(
      ctx.env.DB,
      `SELECT university_id FROM courses WHERE id = ? LIMIT 1`,
      [courseId],
    );
    if (
      !course ||
      (actor.role !== "super_admin" &&
        course.university_id !== actor.university_id)
    ) {
      return errorResponse(404, "not_found", "Course not found.");
    }
  }

  const rows = await queryAll<AssessmentListRow>(
    ctx.env.DB,
    `${SELECT_ASSESSMENT_BASE}
       WHERE a.course_id = ? AND a.deleted_at IS NULL
       ORDER BY a.due_at IS NULL, a.due_at ASC, a.created_at ASC
       LIMIT 200`,
    [courseId],
  );
  return jsonOk(rows.map(toAssessmentListItem));
}

// ---------------------------------------------------------------------------
// POST /api/courses/:id/assessments
// ---------------------------------------------------------------------------

export async function handleCreateAssessment(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Faculty + admin can create. Other roles get 403 (or 404 via the scoping
  // helper for the course-scoped roles).
  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Only faculty can create assessments.",
    );
  }

  let universityId: string;
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      courseId,
      ["faculty"],
    );
    universityId = result.universityId;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const raw = await readJson(ctx.request);
  const parsed = createAssessmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid assessment payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const description = parsed.data.description ?? null;
  const weight = parsed.data.weight ?? 0;
  const maxScore = parsed.data.max_score ?? 100;
  const dueAt = parsed.data.due_at ?? null;

  await execute(
    ctx.env.DB,
    `INSERT INTO assessments
       (id, course_id, title, description, weight, max_score, due_at,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      courseId,
      parsed.data.title,
      description,
      weight,
      maxScore,
      dueAt,
      actor.id,
      now,
      now,
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "assessment.created",
    actorUserId: actor.id,
    universityId,
    entityType: "assessment",
    entityId: id,
    metadata: {
      course_id: courseId,
      title: parsed.data.title,
      weight,
      max_score: maxScore,
      due_at: dueAt,
    },
  });

  const row = await loadAssessment(ctx.env.DB, id);
  if (!row) {
    return errorResponse(500, "create_failed", "Could not create assessment.");
  }
  return jsonOk(toAssessmentListItem(row), { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH /api/assessments/:id
// ---------------------------------------------------------------------------

export async function handleUpdateAssessment(
  ctx: RequestContext,
  assessmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Only faculty can update assessments.",
    );
  }

  const existing = await loadAssessment(ctx.env.DB, assessmentId);
  if (!existing || existing.deleted_at) {
    return errorResponse(404, "not_found", "Assessment not found.");
  }

  let universityId: string;
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      existing.course_id,
      ["faculty"],
    );
    universityId = result.universityId;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const raw = await readJson(ctx.request);
  const parsed = updateAssessmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid assessment payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  if (parsed.data.title !== undefined && parsed.data.title !== existing.title) {
    updates.push("title = ?");
    params.push(parsed.data.title);
    changed.title = { from: existing.title, to: parsed.data.title };
  }
  if (
    parsed.data.description !== undefined &&
    (parsed.data.description ?? null) !== existing.description
  ) {
    const next = parsed.data.description ?? null;
    updates.push("description = ?");
    params.push(next);
    changed.description = { from: existing.description, to: next };
  }
  if (
    parsed.data.weight !== undefined &&
    parsed.data.weight !== Number(existing.weight)
  ) {
    updates.push("weight = ?");
    params.push(parsed.data.weight);
    changed.weight = { from: Number(existing.weight), to: parsed.data.weight };
  }
  if (
    parsed.data.max_score !== undefined &&
    parsed.data.max_score !== Number(existing.max_score)
  ) {
    updates.push("max_score = ?");
    params.push(parsed.data.max_score);
    changed.max_score = {
      from: Number(existing.max_score),
      to: parsed.data.max_score,
    };
  }
  if (
    parsed.data.due_at !== undefined &&
    (parsed.data.due_at ?? null) !== existing.due_at
  ) {
    const next = parsed.data.due_at ?? null;
    updates.push("due_at = ?");
    params.push(next);
    changed.due_at = { from: existing.due_at, to: next };
  }

  if (updates.length === 0) {
    return jsonOk(toAssessmentListItem(existing));
  }

  updates.push("updated_at = ?");
  const now = new Date().toISOString();
  params.push(now);

  await execute(
    ctx.env.DB,
    `UPDATE assessments SET ${updates.join(", ")} WHERE id = ?`,
    [...params, assessmentId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "assessment.updated",
    actorUserId: actor.id,
    universityId,
    entityType: "assessment",
    entityId: assessmentId,
    metadata: { course_id: existing.course_id, changed },
  });

  const next = await loadAssessment(ctx.env.DB, assessmentId);
  if (!next) {
    return errorResponse(500, "update_failed", "Could not update assessment.");
  }
  return jsonOk(toAssessmentListItem(next));
}

// ---------------------------------------------------------------------------
// DELETE /api/assessments/:id  (soft delete)
// ---------------------------------------------------------------------------

export async function handleDeleteAssessment(
  ctx: RequestContext,
  assessmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Only faculty can delete assessments.",
    );
  }

  const existing = await loadAssessment(ctx.env.DB, assessmentId);
  if (!existing || existing.deleted_at) {
    return errorResponse(404, "not_found", "Assessment not found.");
  }

  let universityId: string;
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      existing.course_id,
      ["faculty"],
    );
    universityId = result.universityId;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE assessments SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, assessmentId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "assessment.deleted",
    actorUserId: actor.id,
    universityId,
    entityType: "assessment",
    entityId: assessmentId,
    metadata: {
      course_id: existing.course_id,
      title: existing.title,
      soft_deleted: true,
    },
  });

  return jsonOk({ id: assessmentId, deleted: true });
}

