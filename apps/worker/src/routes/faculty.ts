// Faculty directory (epic UNI-1 §17, UNI-13).
//
//   GET /api/faculty            list (scoped)
//   GET /api/faculty/me         the signed-in faculty member's own row
//   GET /api/faculty/:id        detail (scoped)

import {
  canViewDirectory,
  type FacultyListItem,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type FacultyRow = Row & {
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

const SELECT_LIST = `
  SELECT f.id, f.user_id, f.university_id, f.department_id, f.title,
         f.created_at, f.updated_at,
         u.name AS name, u.email AS email,
         un.name AS university_name,
         d.name  AS department_name
    FROM faculty f
    JOIN users u        ON u.id = f.user_id
    LEFT JOIN universities un ON un.id = f.university_id
    LEFT JOIN departments d   ON d.id  = f.department_id
`;

function toListItem(row: FacultyRow): FacultyListItem {
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

function inScope(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  return actor.university_id !== null && actor.university_id === universityId;
}

export async function handleListFaculty(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canViewDirectory(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the faculty directory.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("f.university_id = ?");
      params.push(universityId);
    }
  } else {
    if (!actor.university_id) return jsonOk([]);
    where.push("f.university_id = ?");
    params.push(actor.university_id);
  }

  const department = ctx.url.searchParams.get("department");
  if (department) {
    where.push("f.department_id = ?");
    params.push(department);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push("(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)");
    params.push(like, like);
  }

  const sql =
    SELECT_LIST +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY u.name ASC LIMIT 200";

  const rows = await queryAll<FacultyRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toListItem));
}

export async function handleGetMyFaculty(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<FacultyRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE f.user_id = ? LIMIT 1`,
    [actor.id],
  );
  if (!row) {
    return errorResponse(
      404,
      "not_found",
      "You don't have a faculty profile in this workspace.",
    );
  }
  return jsonOk(toListItem(row));
}

export async function handleGetFaculty(
  ctx: RequestContext,
  facultyId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<FacultyRow>(
    ctx.env.DB,
    `${SELECT_LIST} WHERE f.id = ? LIMIT 1`,
    [facultyId],
  );
  if (!row) {
    return errorResponse(404, "not_found", "Faculty member not found.");
  }

  const isOwner = row.user_id === actor.id;
  if (!isOwner) {
    if (!canViewDirectory(actor.role) || !inScope(actor, row.university_id)) {
      return errorResponse(404, "not_found", "Faculty member not found.");
    }
  }

  return jsonOk(toListItem(row));
}
