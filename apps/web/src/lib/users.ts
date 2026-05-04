// Frontend client for the users API.

import type {
  Role,
  UpdateUserProfileInput,
  UpdateUserRoleInput,
  UpdateUserStatusInput,
  UserListItem,
  UserStatus,
  UserStatusChangeResult,
} from "@university-hub/shared";

import { api } from "./api";

export interface UserListFilters {
  q?: string;
  role?: Role;
  status?: UserStatus;
  university_id?: string;
}

export function listUsers(
  filters: UserListFilters = {},
  signal?: AbortSignal,
): Promise<UserListItem[]> {
  const query: Record<string, string> = {};
  if (filters.q) query.q = filters.q;
  if (filters.role) query.role = filters.role;
  if (filters.status) query.status = filters.status;
  if (filters.university_id) query.university_id = filters.university_id;
  return api.get<UserListItem[]>("/api/users", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function getUser(id: string, signal?: AbortSignal): Promise<UserListItem> {
  return api.get<UserListItem>(`/api/users/${id}`, { signal });
}

export function updateUserProfile(
  id: string,
  input: UpdateUserProfileInput,
): Promise<UserListItem> {
  return api.patch<UserListItem>(`/api/users/${id}`, input);
}

export function updateUserRole(
  id: string,
  input: UpdateUserRoleInput,
): Promise<UserListItem> {
  return api.patch<UserListItem>(`/api/users/${id}/role`, input);
}

export function updateUserStatus(
  id: string,
  input: UpdateUserStatusInput,
): Promise<UserStatusChangeResult> {
  return api.patch<UserStatusChangeResult>(`/api/users/${id}/status`, input);
}
