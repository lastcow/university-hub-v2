import type { ContactMessageInput } from "@university-hub/shared";

import { api } from "./api";

export interface ContactMessageCreated {
  id: string;
}

export function submitContactMessage(
  input: ContactMessageInput,
  signal?: AbortSignal,
): Promise<ContactMessageCreated> {
  return api.post<ContactMessageCreated>("/api/contact", input, { signal });
}
