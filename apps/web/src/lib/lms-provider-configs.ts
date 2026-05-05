// Frontend client for the LMS provider-config admin API (UNI-53).

import type {
  LmsEnabledProvidersResponse,
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

/**
 * User-facing listing — any authenticated role can call it. Returns
 * only enabled providers for the caller's university, with no
 * admin-relevant fields. Used by `/app/integrations` (UNI-54).
 */
export function listEnabledLmsProviders(
  signal?: AbortSignal,
): Promise<LmsEnabledProvidersResponse> {
  return api.get<LmsEnabledProvidersResponse>(
    "/api/lms/provider-configs/enabled",
    { signal },
  );
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
