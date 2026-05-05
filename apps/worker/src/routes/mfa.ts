// MFA endpoints for the TOTP enrollment + challenge flow (UNI-24).
//
// State machine:
//
//   1. POST /api/auth/sign-in
//        For roles in roleRequiresMfa: instead of a session cookie, the
//        worker issues a short-lived (5 min) `mfa_challenge` cookie and
//        responds with `{ status: "mfa_required", mfa_enrolled }`.
//   2a. mfa_enrolled === false:
//        POST /api/auth/mfa/enroll
//          Generates secret + otpauth URL + 10 recovery codes. Returns
//          codes ONCE; persists secret + hashed recovery codes (but does
//          NOT yet flip mfa_enabled_at).
//        POST /api/auth/mfa/verify-enroll  { code }
//          Confirms first TOTP code, sets mfa_enabled_at, deletes the
//          challenge row, issues the real session cookie.
//   2b. mfa_enrolled === true:
//        POST /api/auth/mfa/challenge  { code }
//          Accepts a 6-digit TOTP or a recovery code (single-use).
//          On success: deletes challenge, issues session.
//
// Already-authenticated user surface (Settings → Security tab):
//   - GET  /api/auth/mfa/status          → enrollment status
//   - POST /api/auth/mfa/recovery-codes  → regenerate (rotates old codes)
//   - POST /api/auth/mfa/disable         → only when role no longer
//                                          requires MFA OR another super_admin
//
// All actions write audit rows (see services/audit.ts and
// shared/constants/audit-actions.ts).

import {
  mfaChallengeInputSchema,
  mfaDisableInputSchema,
  mfaRegenerateRecoveryCodesInputSchema,
  mfaVerifyEnrollInputSchema,
  type MfaEnrollResponse,
  type MfaRecoveryCodesResponse,
  type MfaStatusResponse,
  type MfaVerifyResponse,
  type SessionUser,
} from "@university-hub/shared";

import { computeDeviceFingerprint } from "../auth/device-fingerprint.js";
import {
  createMfaChallenge,
  deleteAllMfaChallengesForUser,
  deleteMfaChallenge,
  resolveMfaChallenge,
} from "../auth/mfa-challenge.js";
import {
  roleAlwaysChallenges,
  roleRequiresMfa,
  roleUsesRiskBasedMfa,
} from "../auth/mfa-policy.js";
import {
  RECOVERY_CODE_TOTAL,
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
  parseRecoveryHashes,
  serializeRecoveryHashes,
} from "../auth/mfa-recovery.js";
import { verifyPassword } from "../auth/password.js";
import { createSession, toSessionUser, type UserRow } from "../auth/session.js";
import {
  countTrustedDevicesForUser,
  createTrustedDevice,
  recordFingerprintMfaSuccess,
  revokeAllTrustedDevicesForUser,
} from "../auth/trusted-device.js";
import {
  buildOtpAuthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from "../auth/totp.js";
import { execute, queryFirst } from "../db/index.js";
import type { Env } from "../env.js";
import type { RequestContext } from "../middleware/auth.js";
import {
  bySession,
  clientIpFromCtx,
  mfaChallengeLimit,
  rateLimitedResponse,
} from "../middleware/rate-limit.js";
import { writeAuditLog } from "../services/audit.js";
import {
  getMfaRevalidationDays,
  getMfaTrustedDeviceDays,
} from "../services/system-settings.js";
import {
  buildMfaChallengeClearCookie,
  buildSessionSetCookie,
  buildTrustedDeviceSetCookie,
} from "../utils/cookies.js";
import { errorResponse, jsonOk } from "../utils/responses.js";
import { trustedDeviceCookieName } from "./trusted-devices.js";

const SESSION_COOKIE_DEFAULT = "university_hub_session";
const MFA_CHALLENGE_COOKIE_DEFAULT = "university_hub_mfa_challenge";

export type MfaUserRow = UserRow & {
  mfa_secret: string | null;
  mfa_enabled_at: string | null;
  mfa_recovery_codes_hash: string | null;
};

function sessionCookieName(env: Env): string {
  return env.SESSION_COOKIE_NAME || SESSION_COOKIE_DEFAULT;
}

export function mfaChallengeCookieName(env: Env): string {
  return env.MFA_CHALLENGE_COOKIE_NAME || MFA_CHALLENGE_COOKIE_DEFAULT;
}

export async function loadMfaUser(
  db: D1Database,
  userId: string,
): Promise<MfaUserRow | null> {
  return queryFirst<MfaUserRow>(
    db,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at,
            mfa_secret, mfa_enabled_at, mfa_recovery_codes_hash
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [userId],
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getMfaChallengeToken(ctx: RequestContext): string | null {
  return ctx.cookies[mfaChallengeCookieName(ctx.env)] ?? null;
}

interface ResolvedChallenge {
  user: MfaUserRow;
  token: string;
}

async function resolveChallengeContext(
  ctx: RequestContext,
): Promise<ResolvedChallenge | Response> {
  const token = getMfaChallengeToken(ctx);
  if (!token) {
    return errorResponse(
      401,
      "mfa_challenge_required",
      "Sign in again to complete MFA verification.",
    );
  }
  const challenge = await resolveMfaChallenge(ctx.env.DB, token);
  if (!challenge) {
    return errorResponse(
      401,
      "mfa_challenge_expired",
      "Your verification window has expired. Sign in again.",
    );
  }
  const user = await loadMfaUser(ctx.env.DB, challenge.user_id);
  if (!user || user.status !== "active") {
    await deleteMfaChallenge(ctx.env.DB, token);
    return errorResponse(401, "account_not_active", "Account is not active.");
  }
  return { user, token };
}

async function issueSessionForUser(
  ctx: RequestContext,
  user: UserRow,
): Promise<{ sessionUser: SessionUser; setCookie: string }> {
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

  const setCookie = buildSessionSetCookie(ctx.env, {
    name: sessionCookieName(ctx.env),
    value: created.token,
    expires: created.expiresAt,
  });

  return { sessionUser: toSessionUser(user), setCookie };
}

function appendCookie(headers: Headers, cookie: string): void {
  headers.append("set-cookie", cookie);
}

/**
 * Record a successful MFA event against the user's device fingerprint
 * (UNI-49). Called from both `verify-enroll` and `challenge` handlers
 * after a TOTP code is accepted; recovery-code success deliberately does
 * NOT record a fingerprint trust because recovery codes are an account-
 * recovery surface, not a "this device is mine" assertion.
 *
 * The fingerprint row is what lets the next sign-in skip MFA inside the
 * revalidation window. It's stored only when the user explicitly opts
 * in via the "Trust this device" checkbox on the challenge page —
 * mirroring how UNI-47's cookie grant requires the same checkbox for
 * `university_admin`. Without an opt-in we keep challenging on every
 * sign-in. (A user who shares a kiosk or hotel browser doesn't tick the
 * box, so no row is written; the next session must re-MFA.)
 *
 * Audit: writes `mfa.device_seen` with the fingerprint id and whether
 * the row was new vs. refreshed. Runs only for roles that participate in
 * the risk-based gate (i.e. NOT admins) — admins are always-challenge
 * and there's no value in tracking their fingerprints.
 */
async function recordRiskFingerprint(
  ctx: RequestContext,
  user: MfaUserRow,
): Promise<void> {
  if (!roleUsesRiskBasedMfa(user.role)) return;
  const ip = clientIpFromCtx(ctx);
  const userAgent = ctx.request.headers.get("user-agent");
  const acceptLanguage = ctx.request.headers.get("accept-language");
  const fingerprint = await computeDeviceFingerprint(ctx.env, {
    userAgent,
    acceptLanguage,
    ip,
  });
  const result = await recordFingerprintMfaSuccess(ctx.env.DB, {
    userId: user.id,
    deviceFingerprintHash: fingerprint.hash,
    label: fingerprint.label,
    ipAddress: ip,
    userAgent,
  });
  await writeAuditLog(ctx.env.DB, {
    action: "mfa.device_seen",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "trusted_device",
    entityId: result.id,
    metadata: {
      role: user.role,
      is_new: result.isNew,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/enroll
//
// Generates a fresh secret + recovery codes for an unenrolled user who has
// just verified their password. Re-callable until verify-enroll succeeds, in
// which case `mfa_enabled_at` flips and further enroll calls 409.
// ---------------------------------------------------------------------------
export async function handleMfaEnroll(ctx: RequestContext): Promise<Response> {
  const resolved = await resolveChallengeContext(ctx);
  if (resolved instanceof Response) return resolved;
  const { user } = resolved;

  if (user.mfa_enabled_at) {
    return errorResponse(
      409,
      "mfa_already_enrolled",
      "MFA is already set up for this account. Submit your code instead.",
    );
  }

  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = await hashRecoveryCodes(recoveryCodes);

  await execute(
    ctx.env.DB,
    `UPDATE users
        SET mfa_secret = ?,
            mfa_recovery_codes_hash = ?,
            mfa_enabled_at = NULL,
            updated_at = ?
      WHERE id = ?`,
    [
      secret,
      serializeRecoveryHashes(recoveryHashes),
      new Date().toISOString(),
      user.id,
    ],
  );

  const issuer = ctx.env.APP_NAME || "University Hub";
  const otpauthUrl = buildOtpAuthUrl({
    secret,
    accountName: user.email,
    issuer,
  });

  const body: MfaEnrollResponse = {
    secret,
    otpauth_url: otpauthUrl,
    recovery_codes: recoveryCodes,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/verify-enroll  { code }
//
// Confirms the first TOTP code, sets `mfa_enabled_at`, deletes the MFA
// challenge row, and issues the real session cookie. Audit: `mfa.enrolled`
// + the usual `auth.sign_in`.
// ---------------------------------------------------------------------------
export async function handleMfaVerifyEnroll(
  ctx: RequestContext,
): Promise<Response> {
  const resolved = await resolveChallengeContext(ctx);
  if (resolved instanceof Response) return resolved;
  const { user, token } = resolved;

  const raw = await readJson(ctx.request);
  const parsed = mfaVerifyEnrollInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Enter the 6-digit code.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  if (!user.mfa_secret) {
    return errorResponse(
      409,
      "mfa_not_started",
      "Start enrollment before verifying. Refresh and sign in again.",
    );
  }
  if (user.mfa_enabled_at) {
    return errorResponse(
      409,
      "mfa_already_enrolled",
      "MFA is already enabled for this account.",
    );
  }

  const ok = await verifyTotpCode(user.mfa_secret, parsed.data.code);
  if (!ok) {
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.challenge_failed",
      actorUserId: user.id,
      universityId: user.university_id,
      entityType: "user",
      entityId: user.id,
      metadata: { stage: "enroll" },
    });
    return errorResponse(
      401,
      "invalid_mfa_code",
      "That code didn't match. Try again with the current code from your authenticator.",
    );
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users SET mfa_enabled_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, user.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "mfa.enrolled",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
  });

  await deleteMfaChallenge(ctx.env.DB, token);

  // First-time enrollment implicitly trusts the enrolling device for
  // non-admin roles (UNI-49). Without this the user gets bounced through
  // a TOTP challenge on the very next sign-in from the same browser,
  // which is surprising onboarding UX. Admins always re-challenge so the
  // record-fingerprint helper no-ops for them by role guard.
  await recordRiskFingerprint(ctx, { ...user, mfa_enabled_at: now });

  const { sessionUser, setCookie } = await issueSessionForUser(ctx, user);

  const headers = new Headers();
  appendCookie(headers, setCookie);
  appendCookie(
    headers,
    buildMfaChallengeClearCookie(ctx.env, mfaChallengeCookieName(ctx.env)),
  );

  const body: MfaVerifyResponse = { user: sessionUser };
  return jsonOk(body, { headers });
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/challenge  { code }
//
// Try TOTP first, then recovery code. On success: delete challenge, issue
// session. Recovery codes are removed from the JSON array on use.
// ---------------------------------------------------------------------------
export async function handleMfaChallenge(
  ctx: RequestContext,
): Promise<Response> {
  const resolved = await resolveChallengeContext(ctx);
  if (resolved instanceof Response) return resolved;
  const { user, token } = resolved;

  // Rate limit per challenge cookie. The challenge token is single-session
  // by construction (one outstanding row per user — see issueMfaChallenge),
  // so this caps brute-forcing of the 6-digit TOTP space inside one sign-in
  // attempt. After the limit trips the user must sign in again, which
  // issues a fresh challenge and resets the counter.
  const limitOutcome = await bySession(
    ctx.env,
    "auth.mfa_challenge",
    token,
    mfaChallengeLimit(ctx.env),
  );
  if (!limitOutcome.allowed) {
    return rateLimitedResponse(
      limitOutcome,
      "Too many verification attempts. Sign in again to continue.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = mfaChallengeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Enter your 6-digit code or a recovery code.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }

  if (!user.mfa_enabled_at || !user.mfa_secret) {
    return errorResponse(
      409,
      "mfa_not_enrolled",
      "MFA is not set up for this account yet.",
    );
  }

  const code = parsed.data.code;
  const looksLikeTotp = /^\d{6}$/.test(code.replace(/\s+/g, ""));

  let usedRecovery = false;
  let totpOk = false;
  if (looksLikeTotp) {
    totpOk = await verifyTotpCode(user.mfa_secret, code);
  }

  let updatedRecoveryJson: string | null = null;
  if (!totpOk) {
    const result = await consumeRecoveryCode(code, user.mfa_recovery_codes_hash);
    if (result.matched) {
      usedRecovery = true;
      updatedRecoveryJson = result.remainingJson;
    }
  }

  if (!totpOk && !usedRecovery) {
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.challenge_failed",
      actorUserId: user.id,
      universityId: user.university_id,
      entityType: "user",
      entityId: user.id,
    });
    return errorResponse(
      401,
      "invalid_mfa_code",
      "That code didn't match. Use the current code from your authenticator or a recovery code.",
    );
  }

  if (usedRecovery && updatedRecoveryJson !== null) {
    await execute(
      ctx.env.DB,
      `UPDATE users SET mfa_recovery_codes_hash = ?, updated_at = ? WHERE id = ?`,
      [updatedRecoveryJson, new Date().toISOString(), user.id],
    );
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.recovery_code_used",
      actorUserId: user.id,
      universityId: user.university_id,
      entityType: "user",
      entityId: user.id,
      metadata: {
        remaining: parseRecoveryHashes(updatedRecoveryJson).length,
      },
    });
  }

  await writeAuditLog(ctx.env.DB, {
    action: "mfa.challenge_passed",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
    metadata: { method: usedRecovery ? "recovery_code" : "totp" },
  });

  await deleteMfaChallenge(ctx.env.DB, token);

  const { sessionUser, setCookie } = await issueSessionForUser(ctx, user);

  const headers = new Headers();
  appendCookie(headers, setCookie);
  appendCookie(
    headers,
    buildMfaChallengeClearCookie(ctx.env, mfaChallengeCookieName(ctx.env)),
  );

  // Trusted-device grant. Two paths, both gated on TOTP success (recovery
  // codes intentionally NOT eligible — they are an account-recovery
  // surface, not a "this device is mine" assertion):
  //
  //   - UNI-47 cookie bypass: `university_admin` who ticked "Remember
  //     this device" gets a signed cookie + exact-IP gate.
  //   - UNI-49 risk-based bypass: any non-admin role that ticked
  //     "Trust this device" gets a server-side fingerprint row keyed on
  //     UA + Accept-Language + IP /16.
  //
  // `super_admin` is always-MFA and gets neither path.
  if (parsed.data.remember_device === true && !usedRecovery) {
    if (user.role === "university_admin") {
      const trustCookie = await grantTrustedDevice(ctx, user);
      if (trustCookie) appendCookie(headers, trustCookie);
    } else if (roleUsesRiskBasedMfa(user.role)) {
      await recordRiskFingerprint(ctx, user);
    }
  }

  const body: MfaVerifyResponse = { user: sessionUser };
  return jsonOk(body, { headers });
}

/**
 * Mint a `trusted_devices` row + signed cookie for the verifying user.
 * Returns the `Set-Cookie` header value the caller should append to the
 * response, or `null` if the gate fails (the gate is also enforced by
 * the call site, but we double-check defensively here so this helper
 * cannot accidentally grant trust to `super_admin`).
 *
 * Audit row: `mfa.trusted_device_granted` with the row id, the configured
 * trust window in days, and the request IP — useful for the audit-logs
 * admin page filter when investigating a suspicious bypass.
 */
async function grantTrustedDevice(
  ctx: RequestContext,
  user: MfaUserRow,
): Promise<string | null> {
  if (user.role !== "university_admin") return null;
  const ip = clientIpFromCtx(ctx);
  const userAgent = ctx.request.headers.get("user-agent");
  const trustWindowDays = await getMfaTrustedDeviceDays(ctx.env.DB);

  const created = await createTrustedDevice(ctx.env, {
    userId: user.id,
    ipAddress: ip,
    userAgent,
    trustWindowDays,
  });

  await writeAuditLog(ctx.env.DB, {
    action: "mfa.trusted_device_granted",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "trusted_device",
    entityId: created.id,
    metadata: {
      trust_window_days: trustWindowDays,
      role: user.role,
    },
  });

  return buildTrustedDeviceSetCookie(ctx.env, {
    name: trustedDeviceCookieName(ctx.env),
    value: created.token,
    expires: created.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// GET /api/auth/mfa/status
//
// Read-only. Used by Settings → Security tab to render MFA state.
// ---------------------------------------------------------------------------
export async function handleMfaStatus(
  ctx: RequestContext,
): Promise<Response> {
  if (!ctx.auth) {
    return errorResponse(401, "unauthenticated", "Authentication required.");
  }
  const user = await loadMfaUser(ctx.env.DB, ctx.auth.user.id);
  if (!user) {
    return errorResponse(404, "user_not_found", "User not found.");
  }
  // UNI-49: any authenticated user gets a clean payload here. UNI-48
  // surfaced "couldn't load MFA status" for faculty because the Settings
  // page hit unimplemented endpoints; this shape now serves every role.
  const trustedDeviceCount = await countTrustedDevicesForUser(
    ctx.env.DB,
    user.id,
  );
  const lastMfaAt = await queryFirst<{ last: string | null }>(
    ctx.env.DB,
    `SELECT MAX(last_mfa_at) AS last
       FROM trusted_devices
      WHERE user_id = ?`,
    [user.id],
  );
  const revalidationDays = await getMfaRevalidationDays(ctx.env.DB);
  const body: MfaStatusResponse = {
    required: roleRequiresMfa(user.role),
    enrolled: Boolean(user.mfa_enabled_at),
    enabled_at: user.mfa_enabled_at,
    recovery_codes_remaining: parseRecoveryHashes(
      user.mfa_recovery_codes_hash,
    ).length,
    last_mfa_at: lastMfaAt?.last ?? null,
    trusted_device_count: trustedDeviceCount,
    revalidation_days: revalidationDays,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/recovery-codes  { password }
//
// Regenerate recovery codes. Old codes are invalidated. Requires the user to
// re-enter their password (defense in depth — limits damage from a stolen
// active session). Returns the new codes ONCE.
// ---------------------------------------------------------------------------
export async function handleMfaRegenerateRecoveryCodes(
  ctx: RequestContext,
): Promise<Response> {
  if (!ctx.auth) {
    return errorResponse(401, "unauthenticated", "Authentication required.");
  }

  const raw = await readJson(ctx.request);
  const parsed = mfaRegenerateRecoveryCodesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Password is required.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const user = await loadMfaUser(ctx.env.DB, ctx.auth.user.id);
  if (!user) {
    return errorResponse(404, "user_not_found", "User not found.");
  }
  if (!user.mfa_enabled_at) {
    return errorResponse(
      409,
      "mfa_not_enrolled",
      "Enroll in MFA before regenerating recovery codes.",
    );
  }
  // Tombstoned (UNI-61) rows have password_hash NULL. Auth middleware filters
  // status='deleted' upstream, but defense-in-depth: never feed NULL into
  // verifyPassword (it presumes a `$`-delimited encoded string and would
  // crash). Fold into the same wrong_password response shape so the handler
  // can't be used as an oracle for tombstone state.
  if (user.password_hash === null) {
    return errorResponse(
      401,
      "wrong_password",
      "That password is not correct.",
    );
  }
  const passwordOk = await verifyPassword(parsed.data.password, user.password_hash);
  if (!passwordOk) {
    return errorResponse(
      401,
      "wrong_password",
      "That password is not correct.",
    );
  }

  const codes = generateRecoveryCodes();
  const hashes = await hashRecoveryCodes(codes);
  await execute(
    ctx.env.DB,
    `UPDATE users SET mfa_recovery_codes_hash = ?, updated_at = ? WHERE id = ?`,
    [serializeRecoveryHashes(hashes), new Date().toISOString(), user.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
    metadata: { count: RECOVERY_CODE_TOTAL },
  });

  const body: MfaRecoveryCodesResponse = { recovery_codes: codes };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/auth/mfa/disable  { password }
//
// Disable MFA on the current account. Only allowed if either:
//   (a) the role no longer requires MFA, or
//   (b) the actor is a different super_admin operating on the user — but
//       that's a future admin-side surface; here we restrict to self-disable
//       for non-required roles.
// Requires password re-entry.
// ---------------------------------------------------------------------------
export async function handleMfaDisable(
  ctx: RequestContext,
): Promise<Response> {
  if (!ctx.auth) {
    return errorResponse(401, "unauthenticated", "Authentication required.");
  }

  const raw = await readJson(ctx.request);
  const parsed = mfaDisableInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Password is required.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const user = await loadMfaUser(ctx.env.DB, ctx.auth.user.id);
  if (!user) {
    return errorResponse(404, "user_not_found", "User not found.");
  }
  if (!user.mfa_enabled_at) {
    return errorResponse(
      409,
      "mfa_not_enrolled",
      "MFA is not enabled for this account.",
    );
  }
  if (roleRequiresMfa(user.role)) {
    return errorResponse(
      403,
      "mfa_required_for_role",
      "MFA is mandatory for your role and cannot be disabled.",
    );
  }
  // See UNI-61 note in handleMfaRegenerateRecoveryCodes — tombstoned rows
  // carry NULL password_hash and must be denied before verifyPassword runs.
  if (user.password_hash === null) {
    return errorResponse(
      401,
      "wrong_password",
      "That password is not correct.",
    );
  }
  const passwordOk = await verifyPassword(parsed.data.password, user.password_hash);
  if (!passwordOk) {
    return errorResponse(
      401,
      "wrong_password",
      "That password is not correct.",
    );
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users
        SET mfa_secret = NULL,
            mfa_enabled_at = NULL,
            mfa_recovery_codes_hash = NULL,
            updated_at = ?
      WHERE id = ?`,
    [now, user.id],
  );
  await deleteAllMfaChallengesForUser(ctx.env.DB, user.id);

  // MFA secret rotation revokes every trusted-device row for this user
  // (UNI-47). Trust grants imply "this device passed TOTP under THE
  // current secret"; if the secret has been rotated out, the trust no
  // longer means anything and must be re-earned on the next sign-in.
  await revokeTrustedDevicesAndAudit(
    ctx,
    user.id,
    user.university_id,
    "mfa_disabled",
  );

  await writeAuditLog(ctx.env.DB, {
    action: "mfa.disabled",
    actorUserId: user.id,
    universityId: user.university_id,
    entityType: "user",
    entityId: user.id,
  });

  return jsonOk({ ok: true } as const);
}

/**
 * Revoke every trusted-device row for `userId` and emit one audit row per
 * deletion. Used by the password-change, MFA-disable, and admin-revoke-
 * all paths so the side effect is consistent across surfaces. The
 * `reason` is captured in metadata so audit-log readers can tell why a
 * sweep happened ("password_changed" vs "mfa_disabled" vs "admin_revoke").
 */
export async function revokeTrustedDevicesAndAudit(
  ctx: RequestContext,
  userId: string,
  universityId: string | null,
  reason: string,
): Promise<number> {
  const ids = await revokeAllTrustedDevicesForUser(ctx.env.DB, userId);
  for (const id of ids) {
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.trusted_device_revoked",
      actorUserId: ctx.auth?.user.id ?? userId,
      universityId,
      entityType: "trusted_device",
      entityId: id,
      metadata: { reason, target_user_id: userId },
    });
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Shared with routes/auth.ts: when a sign-in needs MFA, this builds the
// challenge cookie + body shape. Kept here so the cookie name and TTL stay
// next to the rest of the MFA code.
// ---------------------------------------------------------------------------
export interface MfaChallengeIssued {
  setCookie: string;
  enrolled: boolean;
}

export async function issueMfaChallenge(
  ctx: RequestContext,
  user: MfaUserRow,
): Promise<MfaChallengeIssued> {
  // Replace any prior pending challenges for this user — only the latest
  // sign-in attempt should have a live challenge.
  await deleteAllMfaChallengesForUser(ctx.env.DB, user.id);

  const userAgent = ctx.request.headers.get("user-agent");
  const ipAddress =
    ctx.request.headers.get("cf-connecting-ip") ??
    ctx.request.headers.get("x-forwarded-for") ??
    null;

  const created = await createMfaChallenge(ctx.env.DB, {
    userId: user.id,
    ipAddress,
    userAgent,
  });

  const setCookie = buildSessionSetCookie(ctx.env, {
    name: mfaChallengeCookieName(ctx.env),
    value: created.token,
    expires: created.expiresAt,
  });

  return {
    setCookie,
    enrolled: Boolean(user.mfa_enabled_at),
  };
}
