// Frontend client for the user-facing LMS connections API (UNI-54).
//
// Tokens never leave the Worker; this module only sees `LmsConnectionPublic`
// shapes and the start-flow's authorize URL.

import type {
  DisconnectLmsConnectionResponse,
  LmsConnectionsResponse,
  StartLmsConnectionInput,
  StartLmsConnectionResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function listLmsConnections(
  signal?: AbortSignal,
): Promise<LmsConnectionsResponse> {
  return api.get<LmsConnectionsResponse>("/api/lms/connections", { signal });
}

export function startCanvasConnection(
  input: StartLmsConnectionInput = {},
): Promise<StartLmsConnectionResponse> {
  return api.post<StartLmsConnectionResponse>(
    "/api/lms/connections/canvas/start",
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
