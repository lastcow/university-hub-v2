// Auth middleware. Reads the session token from either the
// `Authorization: Bearer <token>` request header (UNI-70) or the
// `university_hub_session` cookie, resolves it against the DB, and returns
// the resolved user (or null when missing/expired). Route handlers build a
// per-request context that includes this result.
//
// Why two transports (UNI-70): in production the SPA is on `*.pages.dev`
// and the Worker is on `*.workers.dev` — separate eTLD+1's, so every
// request from the SPA is third-party. Privacy-strict browsers (Safari
// ITP, Firefox total cookie protection, Brave, Chrome with 3p cookies
// blocked) silently drop the cross-site `Set-Cookie`, which used to leave
// users authenticated server-side but unauthenticated client-side and
// surfaced as "Authentication required" on every protected page. The SPA
// now persists the raw token returned in the sign-in / MFA-verify response
// body and sends it back as `Authorization: Bearer <token>`. The cookie
// path is preserved as defense in depth for browsers that allow it. UNI-68
// solved the same problem on the short-lived MFA challenge token via
// `X-Mfa-Challenge-Token`; this is the same pattern applied to the
// long-lived session.
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

/** Subset of `ExecutionContext` we expose to handlers. Only `waitUntil`
 *  is used today (UNI-55 sync runner schedules background work after
 *  responding); we keep the type narrow so tests can supply a minimal
 *  fake without claiming the rest of the platform surface. */
export interface ExecutionCtxLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  cookies: Record<string, string>;
  auth: AuthState | null;
  /** Cloudflare's `ExecutionContext` (or a test fake), threaded so
   *  handlers can `executionCtx.waitUntil(...)` background work that
   *  outlives the response. Optional because not every callsite
   *  (notably some tests) supplies one; handlers that need it must
   *  fall back gracefully. */
  executionCtx?: ExecutionCtxLike;
}

export async function buildContext(
  request: Request,
  env: Env,
  executionCtx?: ExecutionCtxLike,
): Promise<RequestContext> {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = getSessionToken(request, cookies, env);
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
  return { request, env, url, cookies, auth, executionCtx };
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

/**
 * UNI-70: pull the session token off the request, preferring the
 * `Authorization: Bearer <token>` header over the
 * `university_hub_session` cookie. Header-first means the SPA can keep
 * authenticating in browsers that drop the cross-site Set-Cookie on the
 * Pages → Worker hop; the cookie is preserved as defense in depth for
 * browsers that allow it. The header value is the same opaque token the
 * worker mints on sign-in / MFA-verify (see `auth/session.ts`); it is
 * never sent on the bare `Cookie` channel.
 *
 * Exported so route handlers (notably `handleSignOut`) can resolve the
 * caller's token by either transport without re-implementing the lookup.
 */
export function getSessionToken(
  request: Request,
  cookies: Record<string, string>,
  env: Env,
): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    // Be lenient on the scheme casing — RFC 7235 says it's
    // case-insensitive ("Bearer", "bearer", "BEARER"). Reject anything
    // else (Basic, Digest, etc.) so a stray Authorization header from a
    // proxy doesn't accidentally resolve as a session.
    const match = /^bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1]) {
      const token = match[1].trim();
      if (token.length > 0) return token;
    }
  }
  const cookieName = env.SESSION_COOKIE_NAME || "university_hub_session";
  return cookies[cookieName] ?? null;
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
