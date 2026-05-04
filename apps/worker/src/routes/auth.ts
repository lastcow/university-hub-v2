// Auth routes: sign-in, sign-out, me. Backend session source of truth.
//
// - Sign-in: validate body via shared zod schema, look up user by lowercased
//   email, verify password with constant-time PBKDF2. If the user's role
//   requires MFA (super_admin / university_admin per UNI-24) the session
//   cookie is NOT issued — instead we issue a short-lived MFA challenge
//   cookie and respond with `{ status: "mfa_required", mfa_enrolled }`.
//   The SPA then completes /api/auth/mfa/{enroll,verify-enroll,challenge}.
//   For roles that don't require MFA the existing flow runs unchanged:
//   create + persist a session, set HttpOnly cookie, audit-log
//   `auth.sign_in`, return `{ status: "ok", user }`.
// - Sign-out: clear session row (if cookie present), clear cookie, audit-log
//   `auth.sign_out`. Idempotent.
// - Me: 401 if unauthenticated, otherwise return SessionUser.
//
// Wrong-email and wrong-password share an identical "Invalid email or
// password." 401 so the response never reveals whether an account exists.

import {
  signInInputSchema,
  type SessionUser,
  type SignInResponse,
} from "@university-hub/shared";

import { roleRequiresMfa } from "../auth/mfa-policy.js";
import { verifyPassword } from "../auth/password.js";
import {
  createSession,
  deleteSessionByToken,
  toSessionUser,
} from "../auth/session.js";
import { execute, queryFirst } from "../db/index.js";
import type { RequestContext } from "../middleware/auth.js";
import { issueMfaChallenge, type MfaUserRow } from "./mfa.js";
import { writeAuditLog } from "../services/audit.js";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
} from "../utils/cookies.js";
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

  // Pull MFA columns alongside the rest in one query so the MFA gate below
  // doesn't need a second round-trip.
  const user = await queryFirst<MfaUserRow>(
    ctx.env.DB,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at,
            mfa_secret, mfa_enabled_at, mfa_recovery_codes_hash
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

  // MFA gate: if the role requires it, hand off to the challenge flow
  // instead of issuing a session. The actual `auth.sign_in` audit row is
  // written when the session is finally created in routes/mfa.ts.
  if (roleRequiresMfa(user.role)) {
    const challenge = await issueMfaChallenge(ctx, user);
    const body: SignInResponse = {
      status: "mfa_required",
      mfa_enrolled: challenge.enrolled,
    };
    return jsonOk(body, { headers: { "set-cookie": challenge.setCookie } });
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

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users SET last_sign_in_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, user.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "auth.sign_in",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
  });

  const sessionUser: SessionUser = toSessionUser(user);

  const setCookie = buildSessionSetCookie(ctx.env, {
    name: sessionCookieName(ctx),
    value: created.token,
    expires: created.expiresAt,
  });

  const body: SignInResponse = { status: "ok", user: sessionUser };
  return jsonOk(body, { headers: { "set-cookie": setCookie } });
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

  const clear = buildSessionClearCookie(ctx.env, cookieName);
  return jsonOk({ ok: true } as const, { headers: { "set-cookie": clear } });
}

export function handleMe(ctx: RequestContext): Response {
  if (!ctx.auth) {
    return errorResponse(401, "unauthenticated", "Authentication required.");
  }
  const sessionUser: SessionUser = toSessionUser(ctx.auth.user);
  return jsonOk(sessionUser);
}

