// Frontend client for the universities API. Same shapes used by the
// /app/universities pages.

import type {
  CreateUniversityInput,
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

export function createUniversity(input: CreateUniversityInput): Promise<University> {
  return api.post<University>("/api/universities", input);
}

export function updateUniversity(
  id: string,
  input: UpdateUniversityInput,
): Promise<University> {
  return api.patch<University>(`/api/universities/${id}`, input);
}
