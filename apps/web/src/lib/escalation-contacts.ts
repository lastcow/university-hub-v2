// Frontend client for the escalation-contacts admin API (UNI-40).

import type {
  EscalationContact,
  EscalationContactRoleKey,
  EscalationContactsResponse,
  UpdateEscalationContactInput,
} from "@university-hub/shared";

import { api } from "./api";

export function listEscalationContacts(
  signal?: AbortSignal,
): Promise<EscalationContactsResponse> {
  return api.get<EscalationContactsResponse>("/api/escalation-contacts", {
    signal,
  });
}

export function updateEscalationContact(
  roleKey: EscalationContactRoleKey,
  input: UpdateEscalationContactInput,
): Promise<EscalationContact> {
  return api.patch<EscalationContact>(
    `/api/escalation-contacts/${roleKey}`,
    input,
  );
}
