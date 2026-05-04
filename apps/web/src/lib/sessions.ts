import type {
  SessionListResponse,
  SessionRevokeAllResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function listMySessions(
  signal?: AbortSignal,
): Promise<SessionListResponse> {
  return api.get<SessionListResponse>("/api/auth/sessions", { signal });
}

export function revokeMySession(sessionId: string): Promise<void> {
  return api.delete<void>(`/api/auth/sessions/${sessionId}`);
}

export function revokeAllOtherSessions(): Promise<SessionRevokeAllResponse> {
  return api.post<SessionRevokeAllResponse>(
    "/api/auth/sessions/revoke-all",
  );
}
