import type {
  SessionUser,
  SignInInput,
  SignInResponse,
} from "@university-hub/shared";

import { api } from "./api";

/**
 * Returns the SignInResponse union — the SPA dispatches on `status` to
 * decide between landing in /app or routing to the MFA step (UNI-24).
 */
export function signIn(input: SignInInput): Promise<SignInResponse> {
  return api.post<SignInResponse>("/api/auth/sign-in", input);
}

export function signOut(): Promise<void> {
  return api.post<void>("/api/auth/sign-out");
}

export function fetchMe(signal?: AbortSignal): Promise<SessionUser> {
  return api.get<SessionUser>("/api/auth/me", { signal });
}
