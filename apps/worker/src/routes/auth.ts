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
import {
  deleteTrustedDeviceById,
  resolveTrustedDeviceByToken,
  touchTrustedDeviceLastUsed,
} from "../auth/trusted-device.js";
import { execute, queryFirst } from "../db/index.js";
import type { RequestContext } from "../middleware/auth.js";
import {
  byEmail,
  byIpEmail,
  clientIpFromCtx,
  passwordResetLimit,
  rateLimitedResponse,
  signInLimit,
} from "../middleware/rate-limit.js";
import { issueMfaChallenge, type MfaUserRow } from "./mfa.js";
import { writeAuditLog } from "../services/audit.js";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
} from "../utils/cookies.js";
import { errorResponse, jsonOk } from "../utils/responses.js";
import { trustedDeviceCookieName } from "./trusted-devices.js";

const MIN_PASSWORD_LENGTH = 8;
const INVALID_CREDENTIALS = "Invalid email or password.";

function sessionCookieName(ctx: RequestContext): string {
  return ctx.env.SESSION_COOKIE_NAME || "university_hub_session";
}

/**
 * Trusted-device MFA bypass check (UNI-47). Returns true iff every gate
 * passes:
 *   - The user's role is exactly `university_admin`. `super_admin` is
 *     always-MFA and never eligible; the bypass is also gated by
 *     `roleRequiresMfa(user.role)` at the call site so non-MFA roles
 *     never hit this path.
 *   - A `device_trust` cookie is present on the request.
 *   - The cookie hashes (via HMAC keyed by `SESSION_SECRET`) to a row in
 *     `trusted_devices` whose `expires_at` is still in the future.
 *   - The row's `ip_address` exactly matches the current request IP.
 *
 * On success the row's `last_used_at` is bumped and an audit row of
 * `mfa.bypassed_via_trusted_device` is written. The caller falls through
 * to the regular session-issuance path.
 *
 * If a cookie is present but does NOT satisfy every gate, the row (if
 * any) is left untouched and the caller still issues an MFA challenge —
 * but a row whose IP failed to match is deliberately NOT deleted, since
 * the user might be roaming and a valid TOTP confirms they are who they
 * say they are. The cookie itself doesn't get cleared either; the next
 * sign-in will simply re-prompt and re-set the trust state.
 */
async function tryTrustedDeviceBypass(
  ctx: RequestContext,
  user: MfaUserRow,
  requestIp: string,
): Promise<boolean> {
  if (user.role !== "university_admin") return false;
  const cookieName = trustedDeviceCookieName(ctx.env);
  const token = ctx.cookies[cookieName];
  if (!token) return false;
  const row = await resolveTrustedDeviceByToken(ctx.env, token);
  if (!row) return false;
  if (row.user_id !== user.id) {
    // Cookie was issued for a different user (e.g. shared device). Drop
    // the row defensively — letting it linger would let an attacker who
    // stole one user's device cookie pretend to be a different
    // university_admin who happens to be signing in from the same IP.
    await deleteTrustedDeviceById(ctx.env.DB, row.id);
    return false;
  }
  if (row.ip_address !== requestIp) return false;

  await touchTrustedDeviceLastUsed(ctx.env.DB, row.id);
  await writeAuditLog(ctx.env.DB, {
    action: "mfa.bypassed_via_trusted_device",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "trusted_device",
    entityId: row.id,
    metadata: {
      ip_match: true,
      role: user.role,
    },
  });
  return true;
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

  // Rate limit BEFORE we do any password work. Counts every attempt regardless
  // of outcome, keyed by (IP, email) so distributed credential-stuffing across
  // the same email is throttled even if it rotates IPs slowly. After the limit
  // trips, even a correct password is denied until the window resets — the
  // attacker has already had 5 swings and we'd rather be wrong about a real
  // user re-trying for 15 minutes than wrong about an attacker.
  const ip = clientIpFromCtx(ctx);
  const limitOutcome = await byIpEmail(
    ctx.env,
    "auth.sign_in",
    ip,
    email,
    signInLimit(ctx.env),
  );
  if (!limitOutcome.allowed) {
    await writeAuditLog(ctx.env.DB, {
      action: "auth.rate_limited",
      actorUserId: null,
      universityId: null,
      entityType: "auth",
      entityId: null,
      metadata: {
        endpoint: "/api/auth/sign-in",
        ip,
        email,
        retry_after_seconds: limitOutcome.retryAfterSeconds,
      },
    });
    return rateLimitedResponse(
      limitOutcome,
      "Too many sign-in attempts. Try again in a few minutes.",
    );
  }

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
  //
  // Trusted-device bypass (UNI-47): if the role is `university_admin`
  // (and ONLY that role — `super_admin` is always-MFA), and the request
  // carries a valid `device_trust` cookie that hashes to a non-expired
  // row whose `ip_address` matches the current request IP, then the MFA
  // challenge is skipped and a session is issued directly. Anything that
  // doesn't satisfy all three conditions falls through to the regular
  // TOTP flow.
  if (roleRequiresMfa(user.role)) {
    const bypass = await tryTrustedDeviceBypass(ctx, user, ip);
    if (!bypass) {
      const challenge = await issueMfaChallenge(ctx, user);
      const body: SignInResponse = {
        status: "mfa_required",
        mfa_enrolled: challenge.enrolled,
        // UNI-47: only `university_admin` is eligible for the trusted-
        // device bypass. `super_admin` is always-MFA — surfaced here so
        // the SPA can hide the "Remember this device" checkbox for
        // super_admin sign-ins.
        trusted_device_eligible: user.role === "university_admin",
      };
      return jsonOk(body, { headers: { "set-cookie": challenge.setCookie } });
    }
    // Bypass took effect — fall through to the session-issuance path below.
  }

  const userAgent = ctx.request.headers.get("user-agent");
  const ipAddress =
    ctx.request.headers.get("cf-connecting-ip") ??
    ctx.request.headers.get("x-forwarded-for") ??
    null;

  const created = await createSession(ctx.env, {
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
    await deleteSessionByToken(ctx.env, token);
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

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset/request   { email }
//
// Public endpoint. Rate-limited to 3 requests per email per hour (UNI-25).
// Token issuance + the actual reset form are tracked separately — this
// surface exists today so credential-stuffing reconnaissance ("does an
// account exist for foo@bar?") and password-reset email floods are capped
// in advance of the full feature.
//
// Always responds 202 with a generic message regardless of whether the
// email matches a real user; that way the response timing / status doesn't
// reveal account existence. The 429 path is the only observable signal,
// and it triggers per email — i.e. an attacker can't probe many emails by
// noticing that one of them gets rate-limited.
// ---------------------------------------------------------------------------
export async function handlePasswordResetRequest(
  ctx: RequestContext,
): Promise<Response> {
  const raw = (await readJson(ctx.request)) as { email?: unknown } | null;
  const email =
    raw && typeof raw === "object" && typeof raw.email === "string"
      ? raw.email.trim().toLowerCase()
      : "";

  if (!email || !email.includes("@") || email.length > 254) {
    return errorResponse(400, "invalid_request", "A valid email is required.");
  }

  const outcome = await byEmail(
    ctx.env,
    "auth.password_reset",
    email,
    passwordResetLimit(ctx.env),
  );
  if (!outcome.allowed) {
    return rateLimitedResponse(
      outcome,
      "Too many password-reset requests for that address. Try again later.",
    );
  }

  // Token issuance + email send is intentionally out of scope here. When
  // that ships, plug it in at this point — the limiter is already in place.
  return jsonOk(
    { ok: true, message: "If an account exists, a reset email is on the way." },
    { status: 202 },
  );
}

