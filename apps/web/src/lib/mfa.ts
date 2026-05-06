// API client for the MFA endpoints (UNI-24).
//
// UNI-68: the pending-MFA challenge token is now passed as the
// `X-Mfa-Challenge-Token` header on every `/enroll`, `/verify-enroll`,
// and `/challenge` request. The token also rides on the
// `university_hub_mfa_challenge` HttpOnly cookie as defense in depth,
// but browsers that block third-party cookies on the Pages → Worker hop
// (Safari ITP, Firefox total cookie protection, Brave, Chrome with 3p
// cookies disabled) drop the cookie — which previously surfaced as
// "Sign in again to complete MFA verification." even when the user
// typed a valid TOTP code. The header path makes the verify step
// independent of cross-site cookie behavior.

import type {
  MfaEnrollResponse,
  MfaRecoveryCodesResponse,
  MfaStatusResponse,
  MfaVerifyResponse,
} from "@university-hub/shared";

import { api } from "./api";

const MFA_CHALLENGE_HEADER = "x-mfa-challenge-token";

function challengeHeaders(token: string | null | undefined): HeadersInit | undefined {
  if (!token) return undefined;
  return { [MFA_CHALLENGE_HEADER]: token };
}

export function startMfaEnrollment(
  challengeToken?: string | null,
): Promise<MfaEnrollResponse> {
  return api.post<MfaEnrollResponse>("/api/auth/mfa/enroll", undefined, {
    headers: challengeHeaders(challengeToken),
  });
}

export function verifyMfaEnrollment(
  code: string,
  challengeToken?: string | null,
): Promise<MfaVerifyResponse> {
  return api.post<MfaVerifyResponse>(
    "/api/auth/mfa/verify-enroll",
    { code },
    { headers: challengeHeaders(challengeToken) },
  );
}

export function submitMfaChallenge(
  code: string,
  options: { rememberDevice?: boolean; challengeToken?: string | null } = {},
): Promise<MfaVerifyResponse> {
  return api.post<MfaVerifyResponse>(
    "/api/auth/mfa/challenge",
    {
      code,
      remember_device: options.rememberDevice ?? false,
    },
    { headers: challengeHeaders(options.challengeToken) },
  );
}

export function getMfaStatus(signal?: AbortSignal): Promise<MfaStatusResponse> {
  return api.get<MfaStatusResponse>("/api/auth/mfa/status", { signal });
}

export function regenerateRecoveryCodes(
  password: string,
): Promise<MfaRecoveryCodesResponse> {
  return api.post<MfaRecoveryCodesResponse>(
    "/api/auth/mfa/recovery-codes",
    { password },
  );
}

export function disableMfa(password: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/auth/mfa/disable", { password });
}
