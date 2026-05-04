import type { SessionUser, SignInInput } from "@university-hub/shared";

import { api } from "./api";

export function signIn(input: SignInInput): Promise<SessionUser> {
  return api.post<SessionUser>("/api/auth/sign-in", input);
}

export function signOut(): Promise<void> {
  return api.post<void>("/api/auth/sign-out");
}

export function fetchMe(signal?: AbortSignal): Promise<SessionUser> {
  return api.get<SessionUser>("/api/auth/me", { signal });
}
