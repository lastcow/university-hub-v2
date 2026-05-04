// Active-sessions surface for the signed-in user (UNI-26).
//
//   GET    /api/auth/sessions           list this user's active sessions
//   DELETE /api/auth/sessions/:id       revoke a specific session
//   POST   /api/auth/sessions/revoke-all  revoke every session except current
//
// Privacy: the `ip_address` column is truncated to a /24 (IPv4) or /48
// (IPv6) prefix before being surfaced — full IPs are useful for fraud /
// abuse review but the user-facing list only needs an "is this me?" hint.
// User-agent strings are trimmed to ~80 chars to avoid surfacing kernel /
// build numbers that some browsers leak in long UA strings.

import type {
  SessionListItem,
  SessionListResponse,
  SessionRevokeAllResponse,
} from "@university-hub/shared";

import {
  deleteSessionById,
  listSessionsForUser,
  revokeAllSessionsForUser,
  absoluteTimeoutSeconds,
  idleTimeoutSeconds,
  type RevokableSession,
} from "../auth/session.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

const USER_AGENT_MAX = 80;

export function truncateIp(ip: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  if (trimmed.includes(".")) {
    const parts = trimmed.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return trimmed;
  }
  if (trimmed.includes(":")) {
    // IPv6 — keep the first three hextets (~ /48), the network-block size
    // most ISPs hand out to a residential customer.
    const blocks = trimmed.split(":").filter((b) => b.length > 0);
    if (blocks.length >= 3) {
      return `${blocks[0]}:${blocks[1]}:${blocks[2]}::/48`;
    }
    return `${trimmed}/48`;
  }
  return trimmed;
}

export function truncateUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const trimmed = ua.trim();
  if (!trimmed) return null;
  if (trimmed.length <= USER_AGENT_MAX) return trimmed;
  return `${trimmed.slice(0, USER_AGENT_MAX - 1)}…`;
}

function toListItem(
  row: RevokableSession,
  currentSessionId: string,
): SessionListItem {
  return {
    id: row.id,
    started_at: row.created_at,
    last_activity_at: row.last_activity_at,
    ip_excerpt: truncateIp(row.ip_address),
    user_agent_excerpt: truncateUserAgent(row.user_agent),
    is_current: row.id === currentSessionId,
  };
}

// ---------------------------------------------------------------------------
// GET /api/auth/sessions
// ---------------------------------------------------------------------------

export async function handleListSessions(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const sessions = await listSessionsForUser(ctx.env.DB, auth.user.id);
  const body: SessionListResponse = {
    sessions: sessions.map((row) => toListItem(row, auth.session.id)),
    idle_timeout_seconds: idleTimeoutSeconds(ctx.env),
    absolute_timeout_seconds: absoluteTimeoutSeconds(ctx.env),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// DELETE /api/auth/sessions/:id
// ---------------------------------------------------------------------------

export async function handleRevokeSession(
  ctx: RequestContext,
  sessionId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;

  // Reject self-revocation through this endpoint — the regular sign-out
  // flow clears the cookie, this one doesn't, and a "logged-in user with a
  // dangling cookie" creates a confusing UX. The frontend hides the revoke
  // button on the current session for the same reason.
  if (sessionId === auth.session.id) {
    return errorResponse(
      400,
      "cannot_revoke_current",
      "Use sign-out to end the current session.",
    );
  }

  // Look the row up explicitly (rather than DELETEing blindly with the
  // user_id filter) so we can return a 404 for a missing/foreign id and
  // keep the audit row tied to a known session id.
  const sessions = await listSessionsForUser(ctx.env.DB, auth.user.id);
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) {
    return errorResponse(404, "not_found", "Session not found.");
  }

  await deleteSessionById(ctx.env.DB, sessionId);

  await writeAuditLog(ctx.env.DB, {
    action: "session.revoked",
    actorUserId: auth.user.id,
    universityId: auth.user.university_id,
    entityType: "session",
    entityId: sessionId,
    metadata: {
      reason: "manual",
      revoked_self: true,
    },
  });

  return jsonOk({ ok: true } as const);
}

// ---------------------------------------------------------------------------
// POST /api/auth/sessions/revoke-all
// ---------------------------------------------------------------------------

export async function handleRevokeAllOtherSessions(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;

  const revokedIds = await revokeAllSessionsForUser(
    ctx.env.DB,
    auth.user.id,
    auth.session.id,
  );

  for (const sessionId of revokedIds) {
    await writeAuditLog(ctx.env.DB, {
      action: "session.revoked",
      actorUserId: auth.user.id,
      universityId: auth.user.university_id,
      entityType: "session",
      entityId: sessionId,
      metadata: {
        reason: "sign_out_all",
        revoked_self: true,
      },
    });
  }

  const body: SessionRevokeAllResponse = { revoked_count: revokedIds.length };
  return jsonOk(body);
}
