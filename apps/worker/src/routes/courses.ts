// Courses CRUD + course assignments (epic UNI-1 §9, §17, §18, §30).
//
//   GET    /api/courses                   list (scoped, ?department=<id>)
//   POST   /api/courses                   create (super_admin or university_admin)
//   GET    /api/courses/:id               detail (scoped)
//   PATCH  /api/courses/:id               update (super_admin or that uni's admin)
//   DELETE /api/courses/:id               delete (also removes assignments)
//
//   GET    /api/courses/:id/assignments   list assignments
//   POST   /api/courses/:id/assignments   add assignment (role per spec §18)
//   DELETE /api/courses/:id/assignments/:assignmentId   remove assignment
//
// Audit log: course.created / .updated / .deleted. Course-assignment writes
// piggyback on `course.updated` with metadata describing the change so we
// don't need a new audit action.

import {
  COURSE_ASSIGNMENT_ROLES,
  createCourseAssignmentInputSchema,
  createCourseInputSchema,
  updateCourseInputSchema,
  type Course,
  type CourseAssignmentListItem,
  type CourseAssignmentRole,
  type CourseListItem,
  type CourseStatus,
  type Role,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
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

type CourseRow = Row & {
  id: string;
  university_id: string;
  department_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  status: CourseStatus;
  created_at: string;
  updated_at: string;
};

type CourseListRow = CourseRow & {
  university_name: string | null;
  department_name: string | null;
  assignment_count: number;
};

type CourseAssignmentRow = Row & {
  id: string;
  course_id: string;
  user_id: string;
  role: CourseAssignmentRole;
  created_at: string;
  updated_at: string;
  user_name: string;
  user_email: string;
  user_role: Role;
};

const SELECT_COURSE = `
  SELECT id, university_id, department_id, name, code, description, status,
         created_at, updated_at
    FROM courses
`;

const SELECT_COURSE_LIST = `
  SELECT c.id, c.university_id, c.department_id, c.name, c.code, c.description,
         c.status, c.created_at, c.updated_at,
         u.name AS university_name,
         d.name AS department_name,
         (SELECT COUNT(1) FROM course_assignments ca WHERE ca.course_id = c.id) AS assignment_count
    FROM courses c
    LEFT JOIN universities u ON u.id = c.university_id
    LEFT JOIN departments d  ON d.id = c.department_id
`;

const SELECT_COURSE_ASSIGNMENT_LIST = `
  SELECT ca.id, ca.course_id, ca.user_id, ca.role, ca.created_at, ca.updated_at,
         u.name AS user_name, u.email AS user_email, u.role AS user_role
    FROM course_assignments ca
    JOIN users u ON u.id = ca.user_id
`;

function toCourse(row: CourseRow): Course {
  return {
    id: row.id,
    university_id: row.university_id,
    department_id: row.department_id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toCourseListItem(row: CourseListRow): CourseListItem {
  return {
    ...toCourse(row),
    university_name: row.university_name,
    department_name: row.department_name,
    assignment_count: Number(row.assignment_count ?? 0),
  };
}

function toCourseAssignment(row: CourseAssignmentRow): CourseAssignmentListItem {
  return {
    id: row.id,
    course_id: row.course_id,
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user_name: row.user_name,
    user_email: row.user_email,
    user_role: row.user_role,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function canRead(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  return actor.university_id !== null && actor.university_id === universityId;
}

function canWrite(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") {
    return actor.university_id !== null && actor.university_id === universityId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/courses
// ---------------------------------------------------------------------------

export async function handleListCourses(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("c.university_id = ?");
      params.push(universityId);
    }
  } else if (actor.university_id) {
    where.push("c.university_id = ?");
    params.push(actor.university_id);
  } else {
    return jsonOk([]);
  }

  const department = ctx.url.searchParams.get("department");
  if (department) {
    where.push("c.department_id = ?");
    params.push(department);
  }
  const status = ctx.url.searchParams.get("status");
  if (status) {
    where.push("c.status = ?");
    params.push(status);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push("(LOWER(c.name) LIKE ? OR LOWER(c.code) LIKE ?)");
    params.push(like, like);
  }

  const sql =
    SELECT_COURSE_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY c.name ASC LIMIT 200";

  const rows = await queryAll<CourseListRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toCourseListItem));
}

// ---------------------------------------------------------------------------
// POST /api/courses
// ---------------------------------------------------------------------------

export async function handleCreateCourse(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (actor.role !== "super_admin" && actor.role !== "university_admin") {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to create courses.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = createCourseInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid course payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  let universityId: string;
  if (actor.role === "super_admin") {
    if (!parsed.data.university_id) {
      return errorResponse(
        400,
        "invalid_request",
        "university_id is required.",
        { issues: { university_id: ["Required"] } },
      );
    }
    universityId = parsed.data.university_id;
  } else {
    if (!actor.university_id) {
      return errorResponse(
        403,
        "forbidden",
        "You aren't linked to a university.",
      );
    }
    universityId = actor.university_id;
  }

  const uni = await queryFirst<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM universities WHERE id = ? LIMIT 1`,
    [universityId],
  );
  if (!uni) {
    return errorResponse(404, "university_not_found", "University not found.");
  }

  // department_id, when provided, must belong to the same university.
  const departmentId = parsed.data.department_id ?? null;
  if (departmentId) {
    const dept = await queryFirst<{ university_id: string }>(
      ctx.env.DB,
      `SELECT university_id FROM departments WHERE id = ? LIMIT 1`,
      [departmentId],
    );
    if (!dept || dept.university_id !== universityId) {
      return errorResponse(
        400,
        "invalid_department",
        "Department does not belong to this university.",
      );
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const code = parsed.data.code ?? null;
  const description = parsed.data.description ?? null;
  const status: CourseStatus = parsed.data.status ?? "active";

  await execute(
    ctx.env.DB,
    `INSERT INTO courses
       (id, university_id, department_id, name, code, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, universityId, departmentId, parsed.data.name, code, description, status, now, now],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "course.created",
    actorUserId: actor.id,
    universityId,
    entityType: "course",
    entityId: id,
    metadata: { name: parsed.data.name, code, department_id: departmentId, status },
  });

  const row = await queryFirst<CourseListRow>(
    ctx.env.DB,
    `${SELECT_COURSE_LIST} WHERE c.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not create course.");
  }
  return jsonOk(toCourseListItem(row), { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/courses/:id
// ---------------------------------------------------------------------------

export async function handleGetCourse(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // UNI-22 smoke-test integration: faculty / teacher / teacher_assistant must
  // be assigned to the course (via course_assignments) to read it. Admins and
  // other roles fall through to the prior canRead() check below.
  if (isCourseScopedRole(actor.role)) {
    try {
      await assertActorOnCourse(ctx.env.DB, toActor(actor), courseId);
    } catch (err) {
      if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
      throw err;
    }
  }

  const row = await queryFirst<CourseListRow>(
    ctx.env.DB,
    `${SELECT_COURSE_LIST} WHERE c.id = ? LIMIT 1`,
    [courseId],
  );
  if (!row || !canRead(actor, row.university_id)) {
    return errorResponse(404, "not_found", "Course not found.");
  }
  return jsonOk(toCourseListItem(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/courses/:id
// ---------------------------------------------------------------------------

export async function handleUpdateCourse(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await queryFirst<CourseRow>(
    ctx.env.DB,
    `${SELECT_COURSE} WHERE id = ? LIMIT 1`,
    [courseId],
  );
  if (!existing || !canRead(actor, existing.university_id)) {
    return errorResponse(404, "not_found", "Course not found.");
  }
  if (!canWrite(actor, existing.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit this course.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateCourseInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid update payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};

  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
    changed.name = parsed.data.name;
  }
  if (parsed.data.code !== undefined && parsed.data.code !== existing.code) {
    updates.push("code = ?");
    params.push(parsed.data.code);
    changed.code = parsed.data.code;
  }
  if (
    parsed.data.description !== undefined &&
    parsed.data.description !== existing.description
  ) {
    updates.push("description = ?");
    params.push(parsed.data.description);
    changed.description = parsed.data.description;
  }
  if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
    updates.push("status = ?");
    params.push(parsed.data.status);
    changed.status = parsed.data.status;
  }
  if (
    parsed.data.department_id !== undefined &&
    parsed.data.department_id !== existing.department_id
  ) {
    const nextDept = parsed.data.department_id;
    if (nextDept) {
      const dept = await queryFirst<{ university_id: string }>(
        ctx.env.DB,
        `SELECT university_id FROM departments WHERE id = ? LIMIT 1`,
        [nextDept],
      );
      if (!dept || dept.university_id !== existing.university_id) {
        return errorResponse(
          400,
          "invalid_department",
          "Department does not belong to this university.",
        );
      }
    }
    updates.push("department_id = ?");
    params.push(nextDept);
    changed.department_id = nextDept;
  }

  if (updates.length === 0) {
    const refreshed = await queryFirst<CourseListRow>(
      ctx.env.DB,
      `${SELECT_COURSE_LIST} WHERE c.id = ? LIMIT 1`,
      [courseId],
    );
    return jsonOk(refreshed ? toCourseListItem(refreshed) : toCourse(existing));
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(courseId);

  await execute(
    ctx.env.DB,
    `UPDATE courses SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  await writeAuditLog(ctx.env.DB, {
    action: "course.updated",
    actorUserId: actor.id,
    universityId: existing.university_id,
    entityType: "course",
    entityId: courseId,
    metadata: { changed },
  });

  const refreshed = await queryFirst<CourseListRow>(
    ctx.env.DB,
    `${SELECT_COURSE_LIST} WHERE c.id = ? LIMIT 1`,
    [courseId],
  );
  return jsonOk(refreshed ? toCourseListItem(refreshed) : toCourse(existing));
}

// ---------------------------------------------------------------------------
// DELETE /api/courses/:id
// ---------------------------------------------------------------------------

export async function handleDeleteCourse(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await queryFirst<CourseRow>(
    ctx.env.DB,
    `${SELECT_COURSE} WHERE id = ? LIMIT 1`,
    [courseId],
  );
  if (!existing || !canRead(actor, existing.university_id)) {
    return errorResponse(404, "not_found", "Course not found.");
  }
  if (!canWrite(actor, existing.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to delete this course.",
    );
  }

  // Course assignments cascade via FK ON DELETE CASCADE; deletion is safe
  // because no other entity references courses.
  await execute(ctx.env.DB, `DELETE FROM courses WHERE id = ?`, [courseId]);

  await writeAuditLog(ctx.env.DB, {
    action: "course.deleted",
    actorUserId: actor.id,
    universityId: existing.university_id,
    entityType: "course",
    entityId: courseId,
    metadata: { name: existing.name, code: existing.code },
  });

  return jsonOk({ id: courseId, deleted: true });
}

// ---------------------------------------------------------------------------
// Course assignments (embedded under a course)
// ---------------------------------------------------------------------------

async function loadCourseForAssignment(
  ctx: RequestContext,
  courseId: string,
): Promise<{ row: CourseRow } | { error: Response }> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return { error: auth };
  const actor = auth.user;

  const existing = await queryFirst<CourseRow>(
    ctx.env.DB,
    `${SELECT_COURSE} WHERE id = ? LIMIT 1`,
    [courseId],
  );
  if (!existing || !canRead(actor, existing.university_id)) {
    return { error: errorResponse(404, "not_found", "Course not found.") };
  }
  return { row: existing };
}

export async function handleListCourseAssignments(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const loaded = await loadCourseForAssignment(ctx, courseId);
  if ("error" in loaded) return loaded.error;

  const roleFilter = ctx.url.searchParams.get("role");
  const where: string[] = ["ca.course_id = ?"];
  const params: unknown[] = [courseId];
  if (roleFilter) {
    where.push("ca.role = ?");
    params.push(roleFilter);
  }

  const rows = await queryAll<CourseAssignmentRow>(
    ctx.env.DB,
    `${SELECT_COURSE_ASSIGNMENT_LIST} WHERE ${where.join(" AND ")} ORDER BY u.name ASC LIMIT 500`,
    params,
  );
  return jsonOk(rows.map(toCourseAssignment));
}

export async function handleCreateCourseAssignment(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const loaded = await loadCourseForAssignment(ctx, courseId);
  if ("error" in loaded) return loaded.error;
  const course = loaded.row;

  if (!canWrite(actor, course.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to assign people to this course.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = createCourseAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid assignment payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  if (!COURSE_ASSIGNMENT_ROLES.includes(parsed.data.role)) {
    return errorResponse(400, "invalid_role", "Invalid assignment role.");
  }

  // The user being assigned must belong to the same university as the course
  // (or be unaffiliated, which is rare but possible for super_admin assigners).
  const target = await queryFirst<{ id: string; university_id: string | null }>(
    ctx.env.DB,
    `SELECT id, university_id FROM users WHERE id = ? LIMIT 1`,
    [parsed.data.user_id],
  );
  if (!target) {
    return errorResponse(404, "user_not_found", "User not found.");
  }
  if (
    target.university_id !== null &&
    target.university_id !== course.university_id
  ) {
    return errorResponse(
      400,
      "user_out_of_scope",
      "That user belongs to a different university.",
    );
  }

  // Schema enforces UNIQUE(course_id, user_id, role); detect collision early
  // to give a friendly error rather than a SQLite constraint failure.
  const existing = await queryFirst<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM course_assignments
       WHERE course_id = ? AND user_id = ? AND role = ? LIMIT 1`,
    [courseId, parsed.data.user_id, parsed.data.role],
  );
  if (existing) {
    return errorResponse(
      409,
      "already_assigned",
      "That user is already assigned to this course in this role.",
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `INSERT INTO course_assignments (id, course_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, courseId, parsed.data.user_id, parsed.data.role, now, now],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "course.updated",
    actorUserId: actor.id,
    universityId: course.university_id,
    entityType: "course",
    entityId: courseId,
    metadata: {
      assignment: "added",
      user_id: parsed.data.user_id,
      role: parsed.data.role,
    },
  });

  const row = await queryFirst<CourseAssignmentRow>(
    ctx.env.DB,
    `${SELECT_COURSE_ASSIGNMENT_LIST} WHERE ca.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not assign user.");
  }
  return jsonOk(toCourseAssignment(row), { status: 201 });
}

export async function handleDeleteCourseAssignment(
  ctx: RequestContext,
  courseId: string,
  assignmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const loaded = await loadCourseForAssignment(ctx, courseId);
  if ("error" in loaded) return loaded.error;
  const course = loaded.row;

  if (!canWrite(actor, course.university_id)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to remove assignments on this course.",
    );
  }

  const assignment = await queryFirst<{ user_id: string; role: CourseAssignmentRole }>(
    ctx.env.DB,
    `SELECT user_id, role FROM course_assignments
       WHERE id = ? AND course_id = ? LIMIT 1`,
    [assignmentId, courseId],
  );
  if (!assignment) {
    return errorResponse(404, "not_found", "Assignment not found.");
  }

  await execute(
    ctx.env.DB,
    `DELETE FROM course_assignments WHERE id = ? AND course_id = ?`,
    [assignmentId, courseId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "course.updated",
    actorUserId: actor.id,
    universityId: course.university_id,
    entityType: "course",
    entityId: courseId,
    metadata: {
      assignment: "removed",
      user_id: assignment.user_id,
      role: assignment.role,
    },
  });

  return jsonOk({ id: assignmentId, deleted: true });
}
