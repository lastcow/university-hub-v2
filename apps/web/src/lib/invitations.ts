// Frontend client for the invitation API. The same shapes used by the
// admin /app/invitations page and the public /accept-invitation page.

import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  InvitationAcceptResult,
  InvitationCreateResult,
  InvitationListItem,
  InvitationLookupResult,
  InvitationStatus,
  SessionUser,
} from "@university-hub/shared";

import { api } from "./api";

export interface InvitationListFilters {
  status?: InvitationStatus;
}

export function listInvitations(
  filters: InvitationListFilters = {},
  signal?: AbortSignal,
): Promise<InvitationListItem[]> {
  return api.get<InvitationListItem[]>("/api/invitations", {
    signal,
    query: filters.status ? { status: filters.status } : undefined,
  });
}

export function getInvitation(
  id: string,
  signal?: AbortSignal,
): Promise<InvitationListItem> {
  return api.get<InvitationListItem>(`/api/invitations/${id}`, { signal });
}

export function createInvitation(
  input: CreateInvitationInput,
): Promise<InvitationCreateResult> {
  return api.post<InvitationCreateResult>("/api/invitations", input);
}

export function revokeInvitation(id: string): Promise<InvitationListItem> {
  return api.post<InvitationListItem>(`/api/invitations/${id}/revoke`);
}

export function resendInvitation(id: string): Promise<InvitationCreateResult> {
  return api.post<InvitationCreateResult>(`/api/invitations/${id}/resend`);
}

export function lookupInvitation(
  token: string,
  signal?: AbortSignal,
): Promise<InvitationLookupResult> {
  return api.get<InvitationLookupResult>("/api/invitations/lookup", {
    signal,
    query: { token },
  });
}

export interface InvitationAcceptResponse extends InvitationAcceptResult {
  user: SessionUser | null;
}

export function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<InvitationAcceptResponse> {
  return api.post<InvitationAcceptResponse>("/api/invitations/accept", input);
}
