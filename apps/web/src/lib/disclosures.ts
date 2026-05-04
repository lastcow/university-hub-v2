// Frontend client for the FERPA disclosure controls (UNI-32).

import type {
  CreateDisclosureConsentInput,
  DisclosureConsent,
  DisclosureConsentListItem,
  DisclosureLogEntry,
  DisclosureLogListResponse,
  ParentMe,
  ParentSignInRequestInput,
  ParentSignInRequestResponse,
  ParentSignInVerifyInput,
  ParentSignInVerifyResponse,
  RecordDisclosureInput,
  StudentGradeEntry,
  StudentListItem,
  UpdateDirectoryInfoInput,
} from "@university-hub/shared";

import { api } from "./api";

// ---------------------------------------------------------------------------
// Directory-info opt-out
// ---------------------------------------------------------------------------

export function updateStudentDirectoryInfo(
  studentId: string,
  input: UpdateDirectoryInfoInput,
): Promise<StudentListItem> {
  return api.patch<StudentListItem>(
    `/api/students/${studentId}/directory-info`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Disclosure consents
// ---------------------------------------------------------------------------

export interface DisclosureConsentsFilters {
  student_user_id?: string;
  university_id?: string;
}

export function listDisclosureConsents(
  filters: DisclosureConsentsFilters = {},
  signal?: AbortSignal,
): Promise<DisclosureConsentListItem[]> {
  const query: Record<string, string> = {};
  if (filters.student_user_id) query.student_user_id = filters.student_user_id;
  if (filters.university_id) query.university_id = filters.university_id;
  return api.get<DisclosureConsentListItem[]>("/api/disclosure-consents", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function createDisclosureConsent(
  input: CreateDisclosureConsentInput,
): Promise<DisclosureConsent> {
  return api.post<DisclosureConsent>("/api/disclosure-consents", input);
}

export function revokeDisclosureConsent(
  id: string,
): Promise<DisclosureConsent> {
  return api.post<DisclosureConsent>(
    `/api/disclosure-consents/${id}/revoke`,
  );
}

// ---------------------------------------------------------------------------
// Disclosure log
// ---------------------------------------------------------------------------

export interface DisclosuresFilters {
  student_user_id?: string;
  consent_id?: string;
  university_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listDisclosures(
  filters: DisclosuresFilters = {},
  signal?: AbortSignal,
): Promise<DisclosureLogListResponse> {
  const query: Record<string, string | number> = {};
  if (filters.student_user_id) query.student_user_id = filters.student_user_id;
  if (filters.consent_id) query.consent_id = filters.consent_id;
  if (filters.university_id) query.university_id = filters.university_id;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.limit !== undefined) query.limit = filters.limit;
  if (filters.offset !== undefined) query.offset = filters.offset;
  return api.get<DisclosureLogListResponse>("/api/disclosures", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function recordDisclosure(
  input: RecordDisclosureInput,
): Promise<DisclosureLogEntry> {
  return api.post<DisclosureLogEntry>("/api/disclosures", input);
}

// ---------------------------------------------------------------------------
// Parent / guardian sign-in
// ---------------------------------------------------------------------------

export function requestParentSignIn(
  input: ParentSignInRequestInput,
): Promise<ParentSignInRequestResponse> {
  return api.post<ParentSignInRequestResponse>(
    "/api/parent/sign-in/request",
    input,
  );
}

export function verifyParentSignIn(
  input: ParentSignInVerifyInput,
): Promise<ParentSignInVerifyResponse> {
  return api.post<ParentSignInVerifyResponse>(
    "/api/parent/sign-in/verify",
    input,
  );
}

export function parentSignOut(): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/parent/sign-out");
}

export function fetchParentMe(signal?: AbortSignal): Promise<ParentMe> {
  return api.get<ParentMe>("/api/parent/me", { signal });
}

export function listParentGrades(
  signal?: AbortSignal,
): Promise<StudentGradeEntry[]> {
  return api.get<StudentGradeEntry[]>("/api/parent/grades", { signal });
}
