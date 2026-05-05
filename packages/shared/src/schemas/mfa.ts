// Request body schemas for the MFA endpoints (UNI-24). Kept tiny — the
// challenge token rides in an HttpOnly cookie, so the bodies only carry
// the user-supplied code.

import { z } from "zod";

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator");

export const recoveryCodeSchema = z
  .string()
  .trim()
  .min(6, "Enter a recovery code")
  .max(64);

export const mfaVerifyEnrollInputSchema = z.object({
  code: totpCodeSchema,
});
export type MfaVerifyEnrollInput = z.infer<typeof mfaVerifyEnrollInputSchema>;

/**
 * `code` is either a 6-digit TOTP or a recovery code (single-use). The
 * server tries TOTP first, falls back to recovery, never reveals which
 * format was attempted.
 *
 * `remember_device` (UNI-47) is the "Remember this device for N days"
 * checkbox on the challenge page. Honored only for `university_admin`
 * users (the bypass does not apply to `super_admin`); ignored otherwise.
 */
export const mfaChallengeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6, "Enter your 6-digit code or a recovery code")
    .max(64),
  remember_device: z.boolean().optional(),
});
export type MfaChallengeInput = z.infer<typeof mfaChallengeInputSchema>;

/**
 * `password` re-confirmation is required to disable MFA — defense in depth
 * against an attacker who somehow holds an active session.
 */
export const mfaDisableInputSchema = z.object({
  password: z.string().min(1, "Password is required"),
});
export type MfaDisableInput = z.infer<typeof mfaDisableInputSchema>;

/** Regenerate recovery codes from Settings → Security. Requires password. */
export const mfaRegenerateRecoveryCodesInputSchema = z.object({
  password: z.string().min(1, "Password is required"),
});
export type MfaRegenerateRecoveryCodesInput = z.infer<
  typeof mfaRegenerateRecoveryCodesInputSchema
>;
