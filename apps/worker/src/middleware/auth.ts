// Auth middleware. Reads the session cookie, resolves it against the DB, and
// returns the resolved user (or null when missing/expired). Route handlers
// build a per-request context that includes this result.
//
// Session lifecycle (UNI-26): every authenticated request is also a
// liveness signal. Before handing the session to handlers, the middleware:
//   1. Compares `last_activity_at` against the idle window
//      (SESSION_IDLE_TIMEOUT_SECONDS, default 30 min).
//   2. Compares `created_at` against the absolute window
//      (SESSION_ABSOLUTE_TIMEOUT_SECONDS, default 12 h).
//   3. On either trip, deletes the session row, writes a `session.revoked`
//      audit entry with the timeout reason, and treats the request as
//      unauthenticated. The route layer turns that into a 401.
//   4. Otherwise it bumps `last_activity_at` to `now` so the idle window
//      slides forward.

import {
  absoluteTimeoutSeconds,
  deleteSessionById,
  idleTimeoutSeconds,
  resolveSessionByToken,
  touchSessionActivity,
  type SessionRow,
  type UserRow,
} from "../auth/session.js";
import { parseCookies } from "../utils/cookies.js";
import type { Env } from "../env.js";
import { writeAuditLog } from "../services/audit.js";

export interface AuthState {
  user: UserRow;
  session: SessionRow;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  cookies: Record<string, string>;
  auth: AuthState | null;
}

export async function buildContext(request: Request, env: Env): Promise<RequestContext> {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookieName = env.SESSION_COOKIE_NAME || "university_hub_session";
  const token = cookies[cookieName];
  let auth: AuthState | null = null;
  if (token) {
    const resolved = await resolveSessionByToken(env, token);
    if (resolved && resolved.user.status === "active") {
      const now = new Date();
      const reason = sessionTimeoutReason(env, resolved.session, now);
      if (reason) {
        await deleteSessionById(env.DB, resolved.session.id);
        await writeAuditLog(env.DB, {
          action: "session.revoked",
          actorUserId: resolved.user.id,
          universityId: resolved.user.university_id,
          entityType: "session",
          entityId: resolved.session.id,
          metadata: {
            reason,
            idle_timeout_seconds: idleTimeoutSeconds(env),
            absolute_timeout_seconds: absoluteTimeoutSeconds(env),
          },
        });
      } else {
        // Slide the idle window. We update on every request — D1 writes are
        // cheap and the spec asks for it explicitly. The updated value is
        // reflected in the in-memory session for handlers that read it.
        await touchSessionActivity(env.DB, resolved.session.id, now);
        resolved.session.last_activity_at = now.toISOString();
        auth = { user: resolved.user, session: resolved.session };
      }
    }
  }
  return { request, env, url, cookies, auth };
}

export type SessionTimeoutReason = "idle_timeout" | "absolute_timeout";

/** Returns the reason this session must be revoked, or null if it's still
 *  valid. Idle wins over absolute when both fire on the same request so the
 *  audit row reflects the more specific signal. */
export function sessionTimeoutReason(
  env: Env,
  session: SessionRow,
  now: Date,
): SessionTimeoutReason | null {
  const nowMs = now.getTime();
  const lastActivityMs = Date.parse(session.last_activity_at);
  const createdAtMs = Date.parse(session.created_at);
  const idleMs = idleTimeoutSeconds(env) * 1000;
  const absoluteMs = absoluteTimeoutSeconds(env) * 1000;

  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs > idleMs) {
    return "idle_timeout";
  }
  if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > absoluteMs) {
    return "absolute_timeout";
  }
  return null;
}

export function requireAuth(ctx: RequestContext): AuthState | Response {
  if (!ctx.auth) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "unauthenticated",
          message: "Authentication required.",
          status: 401,
        },
      },
      { status: 401 },
    );
  }
  return ctx.auth;
}
