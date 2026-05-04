// Teacher-assistants directory + nested course lookup (epic UNI-1 §17, UNI-13).
//
//   GET /api/teacher-assistants                list
//   GET /api/teacher-assistants/me             the signed-in TA's own row
//   GET /api/teacher-assistants/me/courses     courses the TA is assigned to
//   GET /api/teacher-assistants/:id            detail
//   GET /api/teacher-assistants/:id/courses    courses the TA is assigned to

import {
  canViewDirectory,
  type CourseListItem,
  type CourseStatus,
  type TeacherAssistantListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type TaRow = Row & {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
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

const SELECT_TA_LIST = `
  SELECT ta.id, ta.user_id, ta.university_id, ta.department_id,
         ta.created_at, ta.updated_at,
         u.name AS name, u.email AS email,
         un.name AS university_name,
         d.name  AS department_name
    FROM teacher_assistants ta
    JOIN users u        ON u.id = ta.user_id
    LEFT JOIN universities un ON un.id = ta.university_id
    LEFT JOIN departments d   ON d.id  = ta.department_id
`;

const SELECT_TA_COURSES = `
  SELECT c.id, c.university_id, c.department_id, c.name, c.code, c.description,
         c.status, c.created_at, c.updated_at,
         un.name AS university_name,
         d.name  AS department_name,
         (SELECT COUNT(1) FROM course_assignments ca2 WHERE ca2.course_id = c.id) AS assignment_count
    FROM courses c
    JOIN course_assignments ca ON ca.course_id = c.id
    LEFT JOIN universities un ON un.id = c.university_id
    LEFT JOIN departments d   ON d.id  = c.department_id
   WHERE ca.user_id = ? AND ca.role = 'teacher_assistant'
   ORDER BY c.name ASC
   LIMIT 200
`;

function toTa(row: TaRow): TeacherAssistantListItem {
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    department_id: row.department_id,
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

function inScope(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  return actor.university_id !== null && actor.university_id === universityId;
}

async function loadTaForRead(
  ctx: RequestContext,
  actor: UserRow,
  taId: string,
): Promise<TaRow | Response> {
  const row = await queryFirst<TaRow>(
    ctx.env.DB,
    `${SELECT_TA_LIST} WHERE ta.id = ? LIMIT 1`,
    [taId],
  );
  if (!row) return errorResponse(404, "not_found", "Teacher assistant not found.");
  const isOwner = row.user_id === actor.id;
  if (!isOwner) {
    if (!canViewDirectory(actor.role) || !inScope(actor, row.university_id)) {
      return errorResponse(404, "not_found", "Teacher assistant not found.");
    }
  }
  return row;
}

export async function handleListTeacherAssistants(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canViewDirectory(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the teacher-assistant directory.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("ta.university_id = ?");
      params.push(universityId);
    }
  } else {
    if (!actor.university_id) return jsonOk([]);
    where.push("ta.university_id = ?");
    params.push(actor.university_id);
  }

  const department = ctx.url.searchParams.get("department");
  if (department) {
    where.push("ta.department_id = ?");
    params.push(department);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push("(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)");
    params.push(like, like);
  }

  const sql =
    SELECT_TA_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY u.name ASC LIMIT 200";

  const rows = await queryAll<TaRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toTa));
}

async function loadMyTa(
  ctx: RequestContext,
  actor: UserRow,
): Promise<TaRow | Response> {
  const row = await queryFirst<TaRow>(
    ctx.env.DB,
    `${SELECT_TA_LIST} WHERE ta.user_id = ? LIMIT 1`,
    [actor.id],
  );
  if (!row) {
    return errorResponse(
      404,
      "not_found",
      "You don't have a teacher-assistant profile in this workspace.",
    );
  }
  return row;
}

export async function handleGetMyTeacherAssistant(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const row = await loadMyTa(ctx, auth.user);
  if (row instanceof Response) return row;
  return jsonOk(toTa(row));
}

export async function handleListMyTeacherAssistantCourses(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await queryAll<CourseRow>(ctx.env.DB, SELECT_TA_COURSES, [
    auth.user.id,
  ]);
  return jsonOk(rows.map(toCourse));
}

export async function handleGetTeacherAssistant(
  ctx: RequestContext,
  taId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const row = await loadTaForRead(ctx, auth.user, taId);
  if (row instanceof Response) return row;
  return jsonOk(toTa(row));
}

export async function handleListTeacherAssistantCourses(
  ctx: RequestContext,
  taId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const ta = await loadTaForRead(ctx, auth.user, taId);
  if (ta instanceof Response) return ta;
  const rows = await queryAll<CourseRow>(ctx.env.DB, SELECT_TA_COURSES, [
    ta.user_id,
  ]);
  return jsonOk(rows.map(toCourse));
}
