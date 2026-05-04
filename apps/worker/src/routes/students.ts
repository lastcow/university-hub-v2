// Students directory (epic UNI-1 §17, UNI-13).
//
//   GET /api/students             list (scoped to viewer's university)
//   GET /api/students/me          the signed-in student's own row
//   GET /api/students/me/courses  courses the signed-in student is enrolled in
//   GET /api/students/:id         detail (scoped)
//
// Read-only. RBAC:
//   - super_admin / university_admin / staff / faculty / teacher /
//     teacher_assistant may list and read records inside their own university.
//   - super_admin sees every university (and may pass ?university_id=).
//   - A student can read their *own* record via /me (or via /:id when the row
//     belongs to their user_id), even though they cannot list the directory.
//   - Guests / viewers cannot read anything here.

import {
  canViewDirectory,
  type CourseListItem,
  type CourseStatus,
  type StudentListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type StudentRow = Row & {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  student_number: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
};

const SELECT_LIST = `
  SELECT s.id, s.user_id, s.university_id, s.department_id, s.student_number,
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
