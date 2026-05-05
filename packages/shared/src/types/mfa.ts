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
       * UNI-47: surfaces whether the user is eligible for the
       * "Remember this device" trusted-device bypass. True only for
       * `university_admin`. `super_admin` is always-MFA and always
       * false; non-MFA roles never see this response. The SPA uses
       * this to decide whether to render the checkbox on the MFA
       * challenge page. The user's role itself is not surfaced —
       * just the eligibility flag.
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
 */
export interface MfaStatusResponse {
  required: boolean;
  enrolled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
}

/** Returned by `POST /api/auth/mfa/recovery-codes` (regenerate). */
export interface MfaRecoveryCodesResponse {
  recovery_codes: string[];
}
