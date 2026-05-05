// Students directory (epic UNI-1 §17, UNI-13).
//
//   GET   /api/students                       list (scoped to viewer's university)
//   GET   /api/students/me                    the signed-in student's own row
//   GET   /api/students/me/courses            courses the signed-in student is enrolled in
//   GET   /api/students/:id                   detail (scoped)
//   PATCH /api/students/:id/directory-info    FERPA directory-info opt-out (UNI-32)
//
// Read-only outside the directory-info PATCH. RBAC:
//   - super_admin / university_admin / staff / faculty / teacher /
//     teacher_assistant may list and read records inside their own university.
//   - super_admin sees every university (and may pass ?university_id=).
//   - A student can read their *own* record via /me (or via /:id when the row
//     belongs to their user_id), even though they cannot list the directory.
//   - Guests / viewers cannot read anything here.
//
// Directory-info PATCH (UNI-32):
//   - Over-18 student or super_admin / university_admin / staff in scope sets
//     the flag for the student themselves. Under-18 students cannot self-set
//     — that case is handled via the parent / guardian flow (routes/parent-*).

import {
  canViewDirectory,
  updateDirectoryInfoInputSchema,
  type CourseListItem,
  type CourseStatus,
  type StudentListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { isCourseScopedRole } from "../db/scoped.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type StudentRow = Row & {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  student_number: string | null;
  directory_info_opt_out: number;
  under_18: number;
  parent_guardian_email: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
};

const SELECT_LIST = `
  SELECT s.id, s.user_id, s.university_id, s.department_id, s.student_number,
         s.directory_info_opt_out, s.under_18, s.parent_guardian_email,
         s.created_at, s.updated_at,
         u.name AS name, u.email AS email,
         un.name AS university_name,
         d.name  AS department_name
    FROM students s
    JOIN users u        ON u.id = s.user_id
    LEFT JOIN universities un ON un.id = s.university_id
    LEFT JOIN departments d   ON d.id  = s.department_id
`;

function toListItem(row: StudentRow): StudentListItem {
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    department_id: row.department_id,
    student_number: row.student_number,
    directory_info_opt_out: Boolean(row.directory_info_opt_out),
    under_18: Boolean(row.under_18),
    parent_guardian_email: row.parent_guardian_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
    name: row.name,
    email: row.email,
    university_name: row.university_name,
    department_name: row.department_name,
  };
}

function inScope(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  return actor.university_id !== null && actor.university_id === universityId;
}

// ---------------------------------------------------------------------------
// GET /api/students
// ---------------------------------------------------------------------------

export async function handleListStudents(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canViewDirectory(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the student directory.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("s.university_id = ?");
      params.push(universityId);
    }
  } else {
    if (!actor.university_id) return jsonOk([]);
    where.push("s.university_id = ?");
    params.push(actor.university_id);
  }

  // Faculty / teacher / teacher_assistant only see students enrolled in
  // courses they're assigned to. Admins/staff see the full directory.
  if (isCourseScopedRole(actor.role)) {
    where.push(
      `s.user_id IN (
         SELECT ca_student.user_id
           FROM course_assignments ca_student
           JOIN course_assignments ca_self
             ON ca_self.course_id = ca_student.course_id
          WHERE ca_self.user_id = ?
            AND ca_self.role = ?
            AND ca_student.role = 'student'
       )`,
    );
    params.push(actor.id, actor.role);
  }

  const department = ctx.url.searchParams.get("department");
  if (department) {
    where.push("s.department_id = ?");
    params.push(department);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push(
      "(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(s.student_number) LIKE ?)",
    );
    params.push(like, like, like);
  }

  const sql =
    SELECT_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY u.name ASC LIMIT 200";

  const rows = await queryAll<StudentRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toListItem));
}

// ---------------------------------------------------------------------------
// GET /api/students/me — the signed-in student's own row.
// ---------------------------------------------------------------------------

export async function handleGetMyStudent(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<StudentRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE s.user_id = ? LIMIT 1`,
    [actor.id],
  );
  if (!row) {
    return errorResponse(
      404,
      "not_found",
      "You don't have a student profile in this workspace.",
    );
  }
  return jsonOk(toListItem(row));
}

// ---------------------------------------------------------------------------
// GET /api/students/me/courses — courses the signed-in student is enrolled in.
// ---------------------------------------------------------------------------

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
  university_name: string | null;
  department_name: string | null;
  assignment_count: number;
};

const SELECT_STUDENT_COURSES = `
  SELECT c.id, c.university_id, c.department_id, c.name, c.code, c.description,
         c.status, c.created_at, c.updated_at,
         un.name AS university_name,
         d.name  AS department_name,
         (SELECT COUNT(1) FROM course_assignments ca2 WHERE ca2.course_id = c.id) AS assignment_count
    FROM courses c
    JOIN course_assignments ca ON ca.course_id = c.id
    LEFT JOIN universities un ON un.id = c.university_id
    LEFT JOIN departments d   ON d.id  = c.department_id
   WHERE ca.user_id = ? AND ca.role = 'student'
   ORDER BY c.name ASC
   LIMIT 200
`;

function toCourse(row: CourseRow): CourseListItem {
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
    university_name: row.university_name,
    department_name: row.department_name,
    assignment_count: Number(row.assignment_count ?? 0),
  };
}

export async function handleListMyStudentCourses(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await queryAll<CourseRow>(ctx.env.DB, SELECT_STUDENT_COURSES, [
    auth.user.id,
  ]);
  return jsonOk(rows.map(toCourse));
}

// ---------------------------------------------------------------------------
// GET /api/students/:id
// ---------------------------------------------------------------------------

export async function handleGetStudent(
  ctx: RequestContext,
  studentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<StudentRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE s.id = ? LIMIT 1`,
    [studentId],
  );
  if (!row) {
    return errorResponse(404, "not_found", "Student not found.");
  }

  // Owner can always see their own profile, even if they aren't a directory
  // viewer (e.g. plain student). Otherwise the actor must be a directory
  // viewer scoped to the same university.
  const isOwner = row.user_id === actor.id;
  if (!isOwner) {
    if (!canViewDirectory(actor.role) || !inScope(actor, row.university_id)) {
      return errorResponse(404, "not_found", "Student not found.");
    }
  }

  return jsonOk(toListItem(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/students/:id/directory-info — FERPA directory-info opt-out (UNI-32)
//
// FERPA §99.37 lets institutions release "directory information" (name,
// address, photo, etc.) without consent UNLESS the student has opted out.
// Surfacing the opt-out is the user-facing control we owe under the rule.
//
// Authorisation:
//   - The student themselves can set their own flag IF they are over 18.
//     Under-18 students can't self-set; the parent-token flow does that
//     (routes/parent-auth.ts).
//   - super_admin / university_admin / staff in the student's university can
//     set the flag on the student's behalf (paper-signed opt-out, etc.).
//   - All other roles get 403.
//
// We always audit the change with old + new and the actor.
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleUpdateStudentDirectoryInfo(
  ctx: RequestContext,
  studentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<StudentRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE s.id = ? LIMIT 1`,
    [studentId],
  );
  if (!row) {
    return errorResponse(404, "not_found", "Student not found.");
  }

  const isSelf = row.user_id === actor.id;
  const isAdminInScope =
    actor.role === "super_admin" ||
    ((actor.role === "university_admin" || actor.role === "staff") &&
      actor.university_id === row.university_id);
  if (!isSelf && !isAdminInScope) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to update this student's directory-info preference.",
    );
  }
  if (isSelf && Boolean(row.under_18) && !isAdminInScope) {
    return errorResponse(
      403,
      "under_18_self_blocked",
      "Under-18 students cannot change directory-info opt-out themselves; ask your parent or guardian.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateDirectoryInfoInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid directory-info payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const next = parsed.data.directory_info_opt_out ? 1 : 0;
  const prev = Number(row.directory_info_opt_out) ? 1 : 0;
  if (next === prev) {
    return jsonOk(toListItem(row));
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE students SET directory_info_opt_out = ?, updated_at = ? WHERE id = ?`,
    [next, now, studentId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "directory_info.updated",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "student",
    entityId: row.id,
    metadata: {
      student_user_id: row.user_id,
      changed: {
        directory_info_opt_out: { from: Boolean(prev), to: Boolean(next) },
      },
      actor_role: actor.role,
    },
  });

  const updated = await queryFirst<StudentRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE s.id = ? LIMIT 1`,
    [studentId],
  );
  return jsonOk(toListItem(updated ?? row));
}
