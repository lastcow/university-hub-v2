// Email logs admin endpoint (epic UNI-1 §9, §17 + UNI-14).
//
//   GET /api/email-logs   list with filters + pagination
//
// Filters: email_type, recipient, status, from, to.
// Pagination: limit (default 50, max 200), offset (default 0).
//
// RBAC:
//   - super_admin and university_admin only. Every other role gets 403 —
//     email_logs include recipient addresses and Mailgun message IDs and
//     are deliberately gated to the two admin roles per spec §9.
//   - super_admin sees rows across all universities (with optional
//     ?university_id filter); university_admin is locked to their own.

import {
  EMAIL_LOG_STATUSES,
  EMAIL_TYPES,
  type EmailLogListItem,
  type EmailLogListResponse,
  type EmailLogStatus,
  type EmailType,
} from "@university-hub/shared";

import { queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

const ROLES_THAT_CAN_VIEW_EMAIL_LOGS = ["super_admin", "university_admin"] as const;

type ViewerRole = (typeof ROLES_THAT_CAN_VIEW_EMAIL_LOGS)[number];

function isViewerRole(role: string): role is ViewerRole {
  return (ROLES_THAT_CAN_VIEW_EMAIL_LOGS as readonly string[]).includes(role);
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type EmailLogRow = Row & {
  id: string;
  university_id: string | null;
  university_name: string | null;
  recipient_email: string;
  type: EmailType;
  template_name: string | null;
  status: EmailLogStatus;
  mailgun_message_id: string | null;
  error: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
};

type CountRow = Row & { c: number };

const SELECT_EMAIL_LIST = `
  SELECT e.id, e.university_id, e.recipient_email, e.type, e.template_name,
         e.status, e.mailgun_message_id, e.error, e.related_entity_type,
         e.related_entity_id, e.created_at,
         u.name AS university_name
    FROM email_logs e
    LEFT JOIN universities u ON u.id = e.university_id
`;

const SELECT_EMAIL_COUNT = `
  SELECT COUNT(1) AS c
    FROM email_logs e
`;

function toListItem(row: EmailLogRow): EmailLogListItem {
  return {
    id: row.id,
    university_id: row.university_id,
    university_name: row.university_name,
    recipient_email: row.recipient_email,
    type: row.type,
    template_name: row.template_name,
    status: row.status,
    mailgun_message_id: row.mailgun_message_id,
    error: row.error,
    related_entity_type: row.related_entity_type,
    related_entity_id: row.related_entity_id,
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

function isEmailType(s: string): s is EmailType {
  return (EMAIL_TYPES as readonly string[]).includes(s);
}

function isEmailStatus(s: string): s is EmailLogStatus {
  return (EMAIL_LOG_STATUSES as readonly string[]).includes(s);
}

export async function handleListEmailLogs(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!isViewerRole(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view email logs.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const uni = ctx.url.searchParams.get("university_id");
    if (uni) {
      where.push("e.university_id = ?");
      params.push(uni);
    }
  } else {
    where.push("e.university_id = ?");
    params.push(actor.university_id);
  }

  const emailType = ctx.url.searchParams.get("email_type");
  if (emailType) {
    if (!isEmailType(emailType)) {
      return errorResponse(400, "invalid_request", "Unknown email type.");
    }
    where.push("e.type = ?");
    params.push(emailType);
  }

  const recipient = ctx.url.searchParams.get("recipient")?.trim();
  if (recipient) {
    where.push("LOWER(e.recipient_email) LIKE ?");
    params.push(`%${recipient.toLowerCase()}%`);
  }

  const status = ctx.url.searchParams.get("status");
  if (status) {
    if (!isEmailStatus(status)) {
      return errorResponse(400, "invalid_request", "Unknown email-log status.");
    }
    where.push("e.status = ?");
    params.push(status);
  }

  const from = ctx.url.searchParams.get("from");
  if (from) {
    where.push("e.created_at >= ?");
    params.push(from);
  }
  const to = ctx.url.searchParams.get("to");
  if (to) {
    where.push("e.created_at <= ?");
    params.push(to);
  }

  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  const offset = parseOffset(ctx.url.searchParams.get("offset"));

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

  const countRow = await queryFirst<CountRow>(
    ctx.env.DB,
    SELECT_EMAIL_COUNT + whereSql,
    params,
  );
  const total = countRow?.c ?? 0;

  const listSql =
    SELECT_EMAIL_LIST +
    whereSql +
    " ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?";

  const rows = await queryAll<EmailLogRow>(ctx.env.DB, listSql, [
    ...params,
    limit,
    offset,
  ]);

  const body: EmailLogListResponse = {
    items: rows.map(toListItem),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
  return jsonOk(body);
}
