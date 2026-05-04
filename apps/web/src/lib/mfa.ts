// API client for the MFA endpoints (UNI-24). The MFA challenge cookie is
// HttpOnly and managed entirely by the worker; the browser sends it back
// automatically via `credentials: "include"` in the shared API client.

import type {
  MfaEnrollResponse,
  MfaRecoveryCodesResponse,
  MfaStatusResponse,
  MfaVerifyResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function startMfaEnrollment(): Promise<MfaEnrollResponse> {
  return api.post<MfaEnrollResponse>("/api/auth/mfa/enroll");
}

export function verifyMfaEnrollment(code: string): Promise<MfaVerifyResponse> {
  return api.post<MfaVerifyResponse>("/api/auth/mfa/verify-enroll", { code });
}

export function submitMfaChallenge(code: string): Promise<MfaVerifyResponse> {
  return api.post<MfaVerifyResponse>("/api/auth/mfa/challenge", { code });
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
