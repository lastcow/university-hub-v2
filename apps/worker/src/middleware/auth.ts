// Auth middleware. Reads the session cookie, resolves it against the DB, and
// returns the resolved user (or null when missing/expired). Route handlers
// build a per-request context that includes this result.

import { resolveSessionByToken, type SessionRow, type UserRow } from "../auth/session.js";
import { parseCookies } from "../utils/cookies.js";
import type { Env } from "../env.js";

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
    const resolved = await resolveSessionByToken(env.DB, token);
    if (resolved && resolved.user.status === "active") {
      auth = { user: resolved.user, session: resolved.session };
    }
  }
  return { request, env, url, cookies, auth };
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
