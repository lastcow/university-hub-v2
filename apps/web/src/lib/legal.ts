// Frontend client for the legal-document API (UNI-34).

import type {
  LegalAcceptResponse,
  LegalAcknowledgmentStatus,
  LegalAdminDocument,
  LegalAdminResponse,
  LegalDocument,
  LegalDocumentKind,
} from "@university-hub/shared";

import { api } from "./api";

export interface LegalDocumentFetchOptions {
  university_id?: string | null;
  /**
   * Invitation token. The public accept page passes this so the worker
   * can show the right customer's text without exposing university IDs
   * in the URL.
   */
  token?: string | null;
}

export function getLegalDocument(
  kind: LegalDocumentKind,
  options: LegalDocumentFetchOptions = {},
  signal?: AbortSignal,
): Promise<LegalDocument> {
  const query: Record<string, string> = {};
  if (options.university_id) query.university_id = options.university_id;
  if (options.token) query.token = options.token;
  return api.get<LegalDocument>(`/api/legal/${kind}`, {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function getAcknowledgmentStatus(
  signal?: AbortSignal,
): Promise<LegalAcknowledgmentStatus> {
  return api.get<LegalAcknowledgmentStatus>(
    "/api/legal/acknowledgment-status",
    { signal },
  );
}

export function acceptLegal(input: {
  terms_version: number;
  privacy_version: number;
}): Promise<LegalAcceptResponse> {
  return api.post<LegalAcceptResponse>("/api/legal/accept", input);
}

export function getLegalAdmin(
  signal?: AbortSignal,
): Promise<LegalAdminResponse> {
  return api.get<LegalAdminResponse>("/api/legal/admin", { signal });
}

export function updateLegalDocument(
  kind: LegalDocumentKind,
  input: { body_md: string; version_bump?: boolean },
): Promise<LegalAdminDocument> {
  return api.patch<LegalAdminDocument>(`/api/legal/admin/${kind}`, input);
}
