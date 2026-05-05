// MFA payload types shared between the Worker and the SPA (UNI-24).

import type { SessionUser } from "./user.js";

/**
 * Response shape for `POST /api/auth/sign-in`. Either the session is issued
 * immediately (`status: "ok"`), or the user must complete an MFA challenge
 * before we hand back a session cookie. The MFA challenge token itself is
 * carried in an HttpOnly cookie; the body only signals what the SPA should
 * do next.
 */
export type SignInResponse =
  | { status: "ok"; user: SessionUser }
  | {
      status: "mfa_required";
      mfa_enrolled: boolean;
      /**
       * Surfaces whether the user is eligible for the "Trust this device"
       * grant on a successful MFA challenge.
       *
       * UNI-47 (admin-only cookie bypass): a `university_admin` who ticks
       * the checkbox gets a signed cookie + exact-IP gate.
       *
       * UNI-49 (risk-based, all non-admin roles): faculty / teacher /
       * teacher_assistant / student / staff / guest / viewer are eligible
       * to grant trust as well; the checkbox stores a server-side device
       * fingerprint that lets future sign-ins skip the challenge inside
       * `mfa_revalidation_days`.
       *
       * `super_admin` is always-MFA and always `false`. Non-MFA roles
       * never see this response.
       */
      trusted_device_eligible: boolean;
    };

/**
 * Returned by `POST /api/auth/mfa/enroll`. The raw secret + recovery codes
 * are surfaced ONCE, only to the user who just verified their password.
 */
export interface MfaEnrollResponse {
  /** Base32-encoded 160-bit secret. Shown next to the QR code as a fallback. */
  secret: string;
  /** `otpauth://totp/...` URI suitable for QR rendering. */
  otpauth_url: string;
  /** 10 single-use recovery codes — store them now, they are never returned again. */
  recovery_codes: string[];
}

/** Returned by `POST /api/auth/mfa/verify-enroll` and `/challenge` on success. */
export interface MfaVerifyResponse {
  user: SessionUser;
}

/**
 * Returned by `GET /api/auth/mfa/status`. The Settings → Security tab uses
 * this to show whether MFA is enabled and how many recovery codes remain.
 *
 * UNI-49 extends the shape with `last_mfa_at` (newest successful MFA across
 * all devices) and `trusted_device_count` (active fingerprint rows). The
 * endpoint returns 200 for any authenticated user — non-admin roles get
 * the same shape as admins so the UI never lands in the "couldn't load"
 * error state surfaced under UNI-48.
 */
export interface MfaStatusResponse {
  required: boolean;
  enrolled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
  /** UNI-49: timestamp of the newest successful MFA across this user's
   *  trusted-device rows. `null` if MFA was never completed. */
  last_mfa_at: string | null;
  /** UNI-49: number of active trusted-device rows (cookie-trust grants
   *  AND fingerprint-only seen-device rows). */
  trusted_device_count: number;
  /** UNI-49: revalidation window currently in effect. Surfaced so the
   *  UI can phrase "MFA on this device every N days" correctly. */
  revalidation_days: number;
}

/** Returned by `POST /api/auth/mfa/recovery-codes` (regenerate). */
export interface MfaRecoveryCodesResponse {
  recovery_codes: string[];
}
