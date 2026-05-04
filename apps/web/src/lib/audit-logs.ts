// Frontend client for the audit-logs API.

import type {
  AuditAction,
  AuditLogListResponse,
} from "@university-hub/shared";

import { api } from "./api";

export interface AuditLogListFilters {
  action?: AuditAction;
  entity_type?: string;
  actor_user_id?: string;
  university_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listAuditLogs(
  filters: AuditLogListFilters = {},
  signal?: AbortSignal,
): Promise<AuditLogListResponse> {
  const query: Record<string, string | number> = {};
  if (filters.action) query.action = filters.action;
  if (filters.entity_type) query.entity_type = filters.entity_type;
  if (filters.actor_user_id) query.actor_user_id = filters.actor_user_id;
  if (filters.university_id) query.university_id = filters.university_id;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.limit !== undefined) query.limit = filters.limit;
  if (filters.offset !== undefined) query.offset = filters.offset;
  return api.get<AuditLogListResponse>("/api/audit-logs", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}
