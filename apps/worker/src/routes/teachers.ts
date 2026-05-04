// Teachers directory + nested course/student lookups (epic UNI-1 §17, UNI-13).
//
//   GET /api/teachers                list
//   GET /api/teachers/me             the signed-in teacher's own row
//   GET /api/teachers/me/courses     courses assigned to the signed-in teacher
//   GET /api/teachers/me/students    students enrolled in any of those courses
//   GET /api/teachers/:id            detail
//   GET /api/teachers/:id/courses    courses assigned to a teacher
//   GET /api/teachers/:id/students   distinct students across those courses
//
// RBAC mirrors the other directories: directory viewers read everything inside
// their university, owners always see their own profile + nested data.

import {
  canViewDirectory,
  type CourseListItem,
  type CourseStatus,
  type StudentListItem,
  type TeacherListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type TeacherRow = Row & {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
};

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

const SELECT_TEACHER_LIST = `
  SELECT t.id, t.user_id, t.university_id, t.department_id, t.title,
         t.created_at, t.updated_at,
         u.name AS name, u.email AS email,
         un.name AS university_name,
         d.name  AS department_name
    FROM teachers t
    JOIN users u        ON u.id = t.user_id
    LEFT JOIN universities un ON un.id = t.university_id
    LEFT JOIN departments d   ON d.id  = t.department_id
`;

// Courses where the teacher's *user_id* shows up in course_assignments with
// a teacher role. Note we filter by the user_id (not the teachers.id) because
// course_assignments references users.
const SELECT_TEACHER_COURSES = `
  SELECT c.id, c.university_id, c.department_id, c.name, c.code, c.description,
         c.status, c.created_at, c.updated_at,
         un.name AS university_name,
         d.name  AS department_name,
         (SELECT COUNT(1) FROM course_assignments ca2 WHERE ca2.course_id = c.id) AS assignment_count
    FROM courses c
    JOIN course_assignments ca ON ca.course_id = c.id
    LEFT JOIN universities un ON un.id = c.university_id
    LEFT JOIN departments d   ON d.id  = c.department_id
   WHERE ca.user_id = ? AND ca.role = 'teacher'
   ORDER BY c.name ASC
   LIMIT 200
`;

// Distinct students assigned to any of the courses where the teacher teaches.
const SELECT_TEACHER_STUDENTS = `
  SELECT DISTINCT s.id, s.user_id, s.university_id, s.department_id, s.student_number,
         s.directory_info_opt_out, s.under_18, s.parent_guardian_email,
         s.created_at, s.updated_at,
         u.name AS name, u.email AS email,
         un.name AS university_name,
         d.name  AS department_name
    FROM students s
    JOIN users u        ON u.id = s.user_id
    LEFT JOIN universities un ON un.id = s.university_id
    LEFT JOIN departments d   ON d.id  = s.department_id
   WHERE s.user_id IN (
     SELECT ca_student.user_id
       FROM course_assignments ca_student
       JOIN course_assignments ca_teacher
         ON ca_teacher.course_id = ca_student.course_id
      WHERE ca_teacher.user_id = ?
        AND ca_teacher.role = 'teacher'
        AND ca_student.role = 'student'
   )
   ORDER BY u.name ASC
   LIMIT 500
`;

function toTeacher(row: TeacherRow): TeacherListItem {
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    department_id: row.department_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    name: row.name,
    email: row.email,
    university_name: row.university_name,
    department_name: row.department_name,
  };
}

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

function toStudent(row: StudentRow): StudentListItem {
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

async function loadTeacherForRead(
  ctx: RequestContext,
  actor: UserRow,
  teacherId: string,
): Promise<TeacherRow | Response> {
  const row = await queryFirst<TeacherRow>(
    ctx.env.DB,
    `${SELECT_TEACHER_LIST} WHERE t.id = ? LIMIT 1`,
    [teacherId],
  );
  if (!row) return errorResponse(404, "not_found", "Teacher not found.");
  const isOwner = row.user_id === actor.id;
  if (!isOwner) {
    if (!canViewDirectory(actor.role) || !inScope(actor, row.university_id)) {
      return errorResponse(404, "not_found", "Teacher not found.");
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/teachers
// ---------------------------------------------------------------------------

export async function handleListTeachers(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canViewDirectory(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the teacher directory.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("t.university_id = ?");
      params.push(universityId);
    }
  } else {
    if (!actor.university_id) return jsonOk([]);
    where.push("t.university_id = ?");
    params.push(actor.university_id);
  }

  const department = ctx.url.searchParams.get("department");
  if (department) {
    where.push("t.department_id = ?");
    params.push(department);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push("(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)");
    params.push(like, like);
  }

  const sql =
    SELECT_TEACHER_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY u.name ASC LIMIT 200";

  const rows = await queryAll<TeacherRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toTeacher));
}

// ---------------------------------------------------------------------------
// /me variants
// ---------------------------------------------------------------------------

async function loadMyTeacher(
  ctx: RequestContext,
  actor: UserRow,
): Promise<TeacherRow | Response> {
  const row = await queryFirst<TeacherRow>(
    ctx.env.DB,
    `${SELECT_TEACHER_LIST} WHERE t.user_id = ? LIMIT 1`,
    [actor.id],
  );
  if (!row) {
    return errorResponse(
      404,
      "not_found",
      "You don't have a teacher profile in this workspace.",
    );
  }
  return row;
}

export async function handleGetMyTeacher(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const row = await loadMyTeacher(ctx, auth.user);
  if (row instanceof Response) return row;
  return jsonOk(toTeacher(row));
}

export async function handleListMyTeacherCourses(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await queryAll<CourseRow>(ctx.env.DB, SELECT_TEACHER_COURSES, [
    auth.user.id,
  ]);
  return jsonOk(rows.map(toCourse));
}

export async function handleListMyTeacherStudents(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await queryAll<StudentRow>(ctx.env.DB, SELECT_TEACHER_STUDENTS, [
    auth.user.id,
  ]);
  return jsonOk(rows.map(toStudent));
}

// ---------------------------------------------------------------------------
// /:id variants
// ---------------------------------------------------------------------------

export async function handleGetTeacher(
  ctx: RequestContext,
  teacherId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const row = await loadTeacherForRead(ctx, auth.user, teacherId);
  if (row instanceof Response) return row;
  return jsonOk(toTeacher(row));
}

export async function handleListTeacherCourses(
  ctx: RequestContext,
  teacherId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const teacher = await loadTeacherForRead(ctx, auth.user, teacherId);
  if (teacher instanceof Response) return teacher;
  const rows = await queryAll<CourseRow>(ctx.env.DB, SELECT_TEACHER_COURSES, [
    teacher.user_id,
  ]);
  return jsonOk(rows.map(toCourse));
}

export async function handleListTeacherStudents(
  ctx: RequestContext,
  teacherId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const teacher = await loadTeacherForRead(ctx, auth.user, teacherId);
  if (teacher instanceof Response) return teacher;
  const rows = await queryAll<StudentRow>(ctx.env.DB, SELECT_TEACHER_STUDENTS, [
    teacher.user_id,
  ]);
  return jsonOk(rows.map(toStudent));
}
