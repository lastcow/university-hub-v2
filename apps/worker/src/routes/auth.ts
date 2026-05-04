// Auth routes: sign-in, sign-out, me. Backend session source of truth.
//
// - Sign-in: validate body via shared zod schema, look up user by lowercased
//   email, verify password with constant-time PBKDF2, create + persist a new
//   session, set HttpOnly cookie, audit-log `auth.sign_in`, return SessionUser.
// - Sign-out: clear session row (if cookie present), clear cookie, audit-log
//   `auth.sign_out`. Idempotent.
// - Me: 401 if unauthenticated, otherwise return SessionUser.
//
// Wrong-email and wrong-password share an identical "Invalid email or
// password." 401 so the response never reveals whether an account exists.

import { signInInputSchema, type SessionUser } from "@university-hub/shared";

import { verifyPassword } from "../auth/password.js";
import {
  createSession,
  deleteSessionByToken,
  toSessionUser,
  type UserRow,
} from "../auth/session.js";
import { execute, queryFirst } from "../db/index.js";
import { isProduction } from "../env.js";
import type { RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { buildClearCookie, buildSetCookie } from "../utils/cookies.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

const MIN_PASSWORD_LENGTH = 8;
const INVALID_CREDENTIALS = "Invalid email or password.";

function sessionCookieName(ctx: RequestContext): string {
  return ctx.env.SESSION_COOKIE_NAME || "university_hub_session";
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleSignIn(ctx: RequestContext): Promise<Response> {
  const raw = await readJson(ctx.request);
  const parsed = signInInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid sign-in request.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const { email, password } = parsed.data;

  if (password.length < MIN_PASSWORD_LENGTH) {
    return errorResponse(401, "invalid_credentials", INVALID_CREDENTIALS);
  }

  const user = await queryFirst<UserRow>(
    ctx.env.DB,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at
       FROM users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  if (!user) {
    return errorResponse(401, "invalid_credentials", INVALID_CREDENTIALS);
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    return errorResponse(401, "invalid_credentials", INVALID_CREDENTIALS);
  }

  if (user.status !== "active") {
    return errorResponse(
      403,
      "account_not_active",
      "This account is not active. Contact an administrator.",
    );
  }

  const userAgent = ctx.request.headers.get("user-agent");
  const ipAddress =
    ctx.request.headers.get("cf-connecting-ip") ??
    ctx.request.headers.get("x-forwarded-for") ??
    null;

  const created = await createSession(ctx.env.DB, {
    userId: user.id,
    ipAddress,
    userAgent,
  });

  await execute(
    ctx.env.DB,
    `UPDATE users SET last_sign_in_at = ?, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), user.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "auth.sign_in",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
  });

  const sessionUser: SessionUser = toSessionUser(user);

  const setCookie = buildSetCookie({
    name: sessionCookieName(ctx),
    value: created.token,
    expires: created.expiresAt,
    secure: isProduction(ctx.env),
    httpOnly: true,
    sameSite: "Lax",
  });

  return jsonOk(sessionUser, {
    headers: { "set-cookie": setCookie },
  });
}

export async function handleSignOut(ctx: RequestContext): Promise<Response> {
  const cookieName = sessionCookieName(ctx);
  const token = ctx.cookies[cookieName];
  const actor = ctx.auth?.user ?? null;

  if (token) {
    await deleteSessionByToken(ctx.env.DB, token);
  }

  if (actor) {
    await writeAuditLog(ctx.env.DB, {
      action: "auth.sign_out",
      actorUserId: actor.id,
      universityId: actor.university_id,
      entityType: "user",
      entityId: actor.id,
    });
  }

  const clear = buildClearCookie(cookieName, { secure: isProduction(ctx.env) });
  return jsonOk({ ok: true } as const, { headers: { "set-cookie": clear } });
}

export function handleMe(ctx: RequestContext): Response {
  if (!ctx.auth) {
    return errorResponse(401, "unauthenticated", "Authentication required.");
  }
  const sessionUser: SessionUser = toSessionUser(ctx.auth.user);
  return jsonOk(sessionUser);
}
