// Frontend client for the LMS sync orchestration API (UNI-55).
//
// Tokens never leave the Worker; this module only sees normalized
// `LmsSyncRunPublic` shapes.

import type {
  CreateLmsSyncRunResponse,
  LmsConnectionTermsResponse,
  LmsSyncPreviewResponse,
  LmsSyncRunInputSchema,
  LmsSyncRunResponse,
  LmsSyncRunsResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function listLmsConnectionTerms(
  connectionId: string,
  signal?: AbortSignal,
): Promise<LmsConnectionTermsResponse> {
  return api.get<LmsConnectionTermsResponse>(
    `/api/lms/connections/${connectionId}/terms`,
    { signal },
  );
}

export function previewLmsSyncRun(
  input: LmsSyncRunInputSchema,
  signal?: AbortSignal,
): Promise<LmsSyncPreviewResponse> {
  return api.post<LmsSyncPreviewResponse>(
    "/api/lms/sync-runs/preview",
    input,
    { signal },
  );
}

export function createLmsSyncRun(
  input: LmsSyncRunInputSchema,
): Promise<CreateLmsSyncRunResponse> {
  return api.post<CreateLmsSyncRunResponse>("/api/lms/sync-runs", input);
}

export function getLmsSyncRun(
  syncRunId: string,
  signal?: AbortSignal,
): Promise<LmsSyncRunResponse> {
  return api.get<LmsSyncRunResponse>(`/api/lms/sync-runs/${syncRunId}`, {
    signal,
  });
}

export function listLmsSyncRuns(
  signal?: AbortSignal,
): Promise<LmsSyncRunsResponse> {
  return api.get<LmsSyncRunsResponse>("/api/lms/sync-runs", { signal });
}
