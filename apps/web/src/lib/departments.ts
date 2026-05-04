// Frontend client for the departments API.

import type {
  CreateDepartmentInput,
  Department,
  DepartmentListItem,
  UpdateDepartmentInput,
} from "@university-hub/shared";

import { api } from "./api";

export interface DepartmentListFilters {
  university_id?: string;
}

export function listDepartments(
  filters: DepartmentListFilters = {},
  signal?: AbortSignal,
): Promise<DepartmentListItem[]> {
  const query: Record<string, string> = {};
  if (filters.university_id) query.university_id = filters.university_id;
  return api.get<DepartmentListItem[]>("/api/departments", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function getDepartment(
  id: string,
  signal?: AbortSignal,
): Promise<DepartmentListItem> {
  return api.get<DepartmentListItem>(`/api/departments/${id}`, { signal });
}

export function createDepartment(
  input: CreateDepartmentInput,
): Promise<DepartmentListItem> {
  return api.post<DepartmentListItem>("/api/departments", input);
}

export function updateDepartment(
  id: string,
  input: UpdateDepartmentInput,
): Promise<DepartmentListItem | Department> {
  return api.patch<DepartmentListItem | Department>(
    `/api/departments/${id}`,
    input,
  );
}

export function deleteDepartment(id: string): Promise<{ id: string; deleted: boolean }> {
  return api.delete<{ id: string; deleted: boolean }>(`/api/departments/${id}`);
}
