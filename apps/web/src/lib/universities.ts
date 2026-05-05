// Frontend client for the universities API.
//
// `POST /api/universities` is intentionally not exposed: as of UNI-58 the
// server returns 409 single_tenant_deploy for any caller, and the SPA
// edits the deploy's single university record via Settings → University
// (which routes through `lib/settings.ts → updateUniversitySettings`).
// New university deploys are provisioned with
// scripts/provision-university.mjs.

import type {
  University,
  UpdateUniversityInput,
} from "@university-hub/shared";

import { api } from "./api";

export function listUniversities(signal?: AbortSignal): Promise<University[]> {
  return api.get<University[]>("/api/universities", { signal });
}

export function getUniversity(id: string, signal?: AbortSignal): Promise<University> {
  return api.get<University>(`/api/universities/${id}`, { signal });
}

export function updateUniversity(
  id: string,
  input: UpdateUniversityInput,
): Promise<University> {
  return api.patch<University>(`/api/universities/${id}`, input);
}
