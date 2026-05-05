// Frontend client for the user-facing LMS connections API (UNI-54;
// reshaped in UNI-63 to use per-user Personal Access Tokens).
//
// PATs never leave the Worker; this module only sees `LmsConnectionPublic`
// shapes and the connect endpoint's success / failure responses.

import type {
  ConnectCanvasConnectionInput,
  ConnectLmsConnectionResponse,
  DisconnectLmsConnectionResponse,
  LmsConnectionsResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function listLmsConnections(
  signal?: AbortSignal,
): Promise<LmsConnectionsResponse> {
  return api.get<LmsConnectionsResponse>("/api/lms/connections", { signal });
}

export function connectCanvasConnection(
  input: ConnectCanvasConnectionInput,
): Promise<ConnectLmsConnectionResponse> {
  return api.post<ConnectLmsConnectionResponse>(
    "/api/lms/connections/canvas",
    input,
  );
}

export function disconnectLmsConnection(
  connectionId: string,
): Promise<DisconnectLmsConnectionResponse> {
  return api.post<DisconnectLmsConnectionResponse>(
    `/api/lms/connections/${connectionId}/disconnect`,
  );
}
