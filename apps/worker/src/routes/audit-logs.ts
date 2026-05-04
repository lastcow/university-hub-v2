// Audit logs admin endpoint (epic UNI-1 §9, §17, §30 + UNI-14).
//
//   GET /api/audit-logs   list with filters + pagination
//
// Filters: action, entity_type, actor_user_id, from, to.
// Pagination: limit (default 50, max 200), offset (default 0).
//
// RBAC + scoping:
//   - super_admin: sees rows for any university (and may filter by ?university_id).
//   - university_admin: scoped to their own university. They may not widen the
//     scope by passing a different university_id.
//   - All other roles get 403; the audit-log table can leak invitation
//     lifecycle, role-change history, and other admin-sensitive context.
//
// `metadata_json` is parsed server-side into a structured `metadata` field so
// the UI doesn't have to JSON.parse and risk choking on legacy nulls. The raw
// text is returned alongside as `metadata_raw` for debugging.

import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditLogListItem,
  type AuditLogListResponse,
} from "@university-hub/shared";

import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

const ROLES_THAT_CAN_VIEW_AUDIT_LOGS = [
  "super_admin",
  "university_admin",
] as const;

type ViewerRole = (typeof ROLES_THAT_CAN_VIEW_AUDIT_LOGS)[number];

function isViewerRole(role: string): role is ViewerRole {
  return (ROLES_THAT_CAN_VIEW_AUDIT_LOGS as readonly string[]).includes(role);
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AuditRow = Row & {
  id: string;
  university_id: string | null;
  university_name: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: string | null;
  metadata_json: string | null;
  created_at: string;
};

type CountRow = Row & { c: number };

const SELECT_AUDIT_LIST = `
  SELECT a.id, a.university_id, a.actor_user_id, a.action, a.entity_type,
         a.entity_id, a.metadata_json, a.created_at,
         u.name AS university_name,
         actor.name AS actor_name, actor.email AS actor_email
    FROM audit_logs a
    LEFT JOIN universities u ON u.id = a.university_id
    LEFT JOIN users actor    ON actor.id = a.actor_user_id
`;

const SELECT_AUDIT_COUNT = `
  SELECT COUNT(1) AS c
    FROM audit_logs a
`;

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return null;
  }
}

function toListItem(row: AuditRow): AuditLogListItem {
  return {
    id: row.id,
    university_id: row.university_id,
    university_name: row.university_name,
    actor_user_id: row.actor_user_id,
    actor_name: row.actor_name,
    actor_email: row.actor_email,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    metadata: parseMetadata(row.metadata_json),
    metadata_raw: row.metadata_json,
    created_at: row.created_at,
  };
}

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

function isAuditAction(s: string): s is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(s);
}

export async function handleListAuditLogs(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!isViewerRole(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view audit logs.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  // University scoping. super_admin may pass ?university_id=… to narrow;
  // everyone else is locked to their own university and cannot widen.
  if (actor.role === "super_admin") {
    const uni = ctx.url.searchParams.get("university_id");
    if (uni) {
      where.push("a.university_id = ?");
      params.push(uni);
    }
  } else {
    where.push("a.university_id = ?");
    params.push(actor.university_id);
  }

  const action = ctx.url.searchParams.get("action");
  if (action) {
    if (!isAuditAction(action)) {
      return errorResponse(400, "invalid_request", "Unknown audit action.");
    }
    where.push("a.action = ?");
    params.push(action);
  }

  const entityType = ctx.url.searchParams.get("entity_type");
  if (entityType) {
    where.push("a.entity_type = ?");
    params.push(entityType);
  }

  const actorUserId = ctx.url.searchParams.get("actor_user_id");
  if (actorUserId) {
    where.push("a.actor_user_id = ?");
    params.push(actorUserId);
  }

  const from = ctx.url.searchParams.get("from");
  if (from) {
    where.push("a.created_at >= ?");
    params.push(from);
  }
  const to = ctx.url.searchParams.get("to");
  if (to) {
    where.push("a.created_at <= ?");
    params.push(to);
  }

  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  const offset = parseOffset(ctx.url.searchParams.get("offset"));

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  const countRow = await queryFirst<CountRow>(
    ctx.env.DB,
    SELECT_AUDIT_COUNT + whereSql,
    params,
  );
  const total = countRow?.c ?? 0;

  const listSql =
    SELECT_AUDIT_LIST +
    whereSql +
    " ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?";

  const rows = await queryAll<AuditRow>(ctx.env.DB, listSql, [
    ...params,
    limit,
    offset,
  ]);

  const body: AuditLogListResponse = {
    items: rows.map(toListItem),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
  return jsonOk(body);
}
