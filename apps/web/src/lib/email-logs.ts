// Frontend client for the email-logs API.

import type {
  EmailLogListResponse,
  EmailLogStatus,
  EmailType,
} from "@university-hub/shared";

import { api } from "./api";

export interface EmailLogListFilters {
  email_type?: EmailType;
  recipient?: string;
  status?: EmailLogStatus;
  university_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listEmailLogs(
  filters: EmailLogListFilters = {},
  signal?: AbortSignal,
): Promise<EmailLogListResponse> {
  const query: Record<string, string | number> = {};
  if (filters.email_type) query.email_type = filters.email_type;
  if (filters.recipient) query.recipient = filters.recipient;
  if (filters.status) query.status = filters.status;
  if (filters.university_id) query.university_id = filters.university_id;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.limit !== undefined) query.limit = filters.limit;
  if (filters.offset !== undefined) query.offset = filters.offset;
  return api.get<EmailLogListResponse>("/api/email-logs", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}
