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

import { computeDeviceFingerprint } from "../auth/device-fingerprint.js";
import {
  roleAlwaysChallenges,
  roleRequiresMfa,
  roleUsesRiskBasedMfa,
} from "../auth/mfa-policy.js";
import { verifyPassword } from "../auth/password.js";
import {
  createSession,
  deleteSessionByToken,
  toSessionUser,
} from "../auth/session.js";
import {
  deleteTrustedDeviceById,
  findTrustedDeviceByFingerprint,
  resolveTrustedDeviceByToken,
  touchTrustedDeviceLastUsed,
  touchTrustedDeviceSeen,
} from "../auth/trusted-device.js";
import { getMfaRevalidationDays } from "../services/system-settings.js";
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

/**
 * UNI-49 risk-based MFA gate for non-admin roles.
 *
 *   - `super_admin` and `university_admin` go through the every-time
 *     challenge path and never reach this function.
 *   - For roles in the risk-based bucket (faculty, teacher,
 *     teacher_assistant, student, staff, guest, viewer), we look up a
 *     trusted-device row keyed on (user_id, server-side fingerprint). If
 *     the row exists and `last_mfa_at` is within `mfa_revalidation_days`,
 *     we skip the challenge and bump `last_seen_at`. Otherwise the user
 *     is challenged and a fresh fingerprint row will be written on the
 *     next successful TOTP.
 *
 * Returns `true` to bypass MFA, `false` to fall through to the normal
 * challenge. The fingerprint is recomputed on every sign-in attempt;
 * SESSION_SECRET rotation invalidates the row by failing re-derivation
 * under the new key, mirroring the session / cookie surfaces.
 */
async function tryRevalidationWindowBypass(
  ctx: RequestContext,
  user: MfaUserRow,
  requestIp: string,
): Promise<boolean> {
  if (!roleUsesRiskBasedMfa(user.role)) return false;
  if (!user.mfa_enabled_at) return false; // not enrolled — must run enroll flow
  const fingerprint = await computeDeviceFingerprint(ctx.env, {
    userAgent: ctx.request.headers.get("user-agent"),
    acceptLanguage: ctx.request.headers.get("accept-language"),
    ip: requestIp,
  });
  const row = await findTrustedDeviceByFingerprint(
    ctx.env.DB,
    user.id,
    fingerprint.hash,
  );
  if (!row || !row.last_mfa_at) return false;

  const revalDays = await getMfaRevalidationDays(ctx.env.DB);
  const cutoffMs = Date.now() - revalDays * 24 * 60 * 60 * 1000;
  if (Date.parse(row.last_mfa_at) < cutoffMs) return false;

  await touchTrustedDeviceSeen(ctx.env.DB, row.id);
  await writeAuditLog(ctx.env.DB, {
    action: "mfa.bypassed_via_revalidation_window",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "trusted_device",
    entityId: row.id,
    metadata: {
      role: user.role,
      revalidation_days: revalDays,
      last_mfa_at: row.last_mfa_at,
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

  // Tombstoned (UNI-61) rows have password_hash NULL — fold them into the
  // same generic 401 as wrong-email/wrong-password. Returning a different
  // status would (a) leak that the deterministic `removed-<uuid>@local.invalid`
  // address resolves to a real anonymized row, and (b) crash verifyPassword,
  // which presumes a `$`-delimited encoded string.
  if (user.password_hash === null) {
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

  // MFA gate: every authenticated role enrolls in TOTP on first sign-in
  // (UNI-49); the actual `auth.sign_in` audit row is written when the
  // session is finally created in routes/mfa.ts.
  //
  //   - `super_admin` + `university_admin` are "always challenge" — every
  //     sign-in runs through TOTP. The UNI-47 trusted-device cookie
  //     bypass is the one exception, and only for `university_admin`
  //     (matching today's behavior; rolling it back is out of scope and
  //     would invalidate live cookies).
  //   - Non-admin roles use the risk-based gate: skip MFA when the device
  //     fingerprint matches a row whose `last_mfa_at` is fresh.
  if (roleRequiresMfa(user.role)) {
    let bypassed = false;
    if (user.role === "university_admin") {
      bypassed = await tryTrustedDeviceBypass(ctx, user, ip);
    }
    if (!bypassed && roleUsesRiskBasedMfa(user.role)) {
      bypassed = await tryRevalidationWindowBypass(ctx, user, ip);
    }
    if (!bypassed) {
      const challenge = await issueMfaChallenge(ctx, user);
      const body: SignInResponse = {
        status: "mfa_required",
        mfa_enrolled: challenge.enrolled,
        // `super_admin` always-MFA → no checkbox.
        // `university_admin` keeps the UNI-47 cookie-bypass option.
        // Every other role gets the UNI-49 risk-based grant on success.
        trusted_device_eligible: !roleAlwaysChallenges(user.role)
          ? true
          : user.role === "university_admin",
        // UNI-68: surface the token in the body too so the SPA can echo
        // it back via `X-Mfa-Challenge-Token` on the verify endpoints.
        // Browsers that block third-party cookies on the Pages → Worker
        // hop drop the matching `Set-Cookie` below; without the token in
        // the body the verify step would always 401 with
        // "Sign in again to complete MFA verification."
        mfa_challenge_token: challenge.token,
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

