// Frontend client for the LMS provider-config admin API (UNI-53).

import type {
  LmsProviderConfigPublic,
  LmsProviderConfigsResponse,
  UpdateLmsProviderConfigInput,
} from "@university-hub/shared";

import { api } from "./api";

export function listLmsProviderConfigs(
  signal?: AbortSignal,
): Promise<LmsProviderConfigsResponse> {
  return api.get<LmsProviderConfigsResponse>("/api/lms/provider-configs", {
    signal,
  });
}

export function upsertLmsProviderConfig(
  input: UpdateLmsProviderConfigInput,
): Promise<LmsProviderConfigPublic> {
  return api.post<LmsProviderConfigPublic>(
    "/api/lms/provider-configs",
    input,
  );
}

export function deleteLmsProviderConfig(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/api/lms/provider-configs/${id}`);
}
