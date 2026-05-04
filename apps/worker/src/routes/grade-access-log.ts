// FERPA record-of-access admin endpoint (epic UNI-21 / sub-issue UNI-30).
//
//   GET /api/grade-access-log   list with filters + pagination
//
// Filters: student_user_id, viewer_user_id, course_id, from, to.
// Pagination: limit (default 50, max 200), offset (default 0).
//
// RBAC + scoping:
//   - super_admin: can see every row, may filter by ?university_id
//     (joined via courses.university_id).
//   - university_admin: scoped to their own university (university filter is
//     overridden — they can't widen it).
//   - All other roles get 403; the table aggregates disclosures across
//     courses and students and is admin-only by FERPA design.

import type { GradeAccessLogEntry, GradeAccessLogListResponse, Role } from "@university-hub/shared";

import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type AccessLogRow = Row & {
  id: string;
  viewer_user_id: string | null;
  viewer_role: string;
  viewer_course_role: string | null;
  course_id: string | null;
  assessment_id: string | null;
  viewed_grade_id: string | null;
  viewed_student_user_id: string | null;
  context: string;
  accessed_at: string;
  viewer_name: string | null;
  viewer_email: string | null;
  course_name: string | null;
  course_university_id: string | null;
  assessment_title: string | null;
  viewed_student_name: string | null;
  viewed_student_email: string | null;
};

type CountRow = Row & { c: number };

const SELECT_BASE = `
  SELECT al.id, al.viewer_user_id, al.viewer_role, al.viewer_course_role,
         al.course_id, al.assessment_id, al.viewed_grade_id,
         al.viewed_student_user_id, al.context, al.accessed_at,
         viewer.name AS viewer_name, viewer.email AS viewer_email,
         c.name AS course_name, c.university_id AS course_university_id,
         a.title AS assessment_title,
         student.name AS viewed_student_name,
         student.email AS viewed_student_email
    FROM grade_access_log al
    LEFT JOIN users viewer ON viewer.id = al.viewer_user_id
    LEFT JOIN users student ON student.id = al.viewed_student_user_id
    LEFT JOIN courses c ON c.id = al.course_id
    LEFT JOIN assessments a ON a.id = al.assessment_id
`;

const SELECT_COUNT = `
  SELECT COUNT(1) AS c
    FROM grade_access_log al
    LEFT JOIN courses c ON c.id = al.course_id
`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function toEntry(row: AccessLogRow): GradeAccessLogEntry {
  return {
    id: row.id,
    viewer_user_id: row.viewer_user_id,
    viewer_name: row.viewer_name,
    viewer_email: row.viewer_email,
    viewer_role: row.viewer_role,
    viewer_course_role: row.viewer_course_role,
    course_id: row.course_id,
    course_name: row.course_name,
    assessment_id: row.assessment_id,
    assessment_title: row.assessment_title,
    viewed_grade_id: row.viewed_grade_id,
    viewed_student_user_id: row.viewed_student_user_id,
    viewed_student_name: row.viewed_student_name,
    viewed_student_email: row.viewed_student_email,
    context: row.context,
    accessed_at: row.accessed_at,
  };
}

export async function handleListGradeAccessLog(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const role: Role = actor.role;
  if (role !== "super_admin" && role !== "university_admin") {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view grade access logs.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (role === "university_admin") {
    if (!actor.university_id) {
      return jsonOk<GradeAccessLogListResponse>({
        items: [],
        total: 0,
        limit: DEFAULT_LIMIT,
        offset: 0,
        has_more: false,
      });
    }
    where.push("c.university_id = ?");
    params.push(actor.university_id);
  } else {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("c.university_id = ?");
      params.push(universityId);
    }
  }

  const studentId = ctx.url.searchParams.get("student_user_id");
  if (studentId) {
    where.push("al.viewed_student_user_id = ?");
    params.push(studentId);
  }
  const viewerId = ctx.url.searchParams.get("viewer_user_id");
  if (viewerId) {
    where.push("al.viewer_user_id = ?");
    params.push(viewerId);
  }
  const courseId = ctx.url.searchParams.get("course_id");
  if (courseId) {
    where.push("al.course_id = ?");
    params.push(courseId);
  }
  const from = ctx.url.searchParams.get("from");
  if (from) {
    where.push("al.accessed_at >= ?");
    params.push(from);
  }
  const to = ctx.url.searchParams.get("to");
  if (to) {
    where.push("al.accessed_at <= ?");
    params.push(to);
  }

  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  const offset = parseOffset(ctx.url.searchParams.get("offset"));

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const listSql =
    SELECT_BASE +
    whereSql +
    " ORDER BY al.accessed_at DESC LIMIT ? OFFSET ?";
  const countSql = SELECT_COUNT + whereSql;

  const [rows, countRow] = await Promise.all([
    queryAll<AccessLogRow>(ctx.env.DB, listSql, [...params, limit, offset]),
    queryFirst<CountRow>(ctx.env.DB, countSql, params),
  ]);
  const total = Number(countRow?.c ?? 0);

  const body: GradeAccessLogListResponse = {
    items: rows.map(toEntry),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
  return jsonOk(body);
}
