// Frontend client for the courses + course-assignments API.

import type {
  Course,
  CourseAssignmentListItem,
  CourseListItem,
  CourseStatus,
  CreateCourseAssignmentInput,
  CreateCourseInput,
  UpdateCourseInput,
} from "@university-hub/shared";

import { api } from "./api";

export interface CourseListFilters {
  university_id?: string;
  department?: string;
  status?: CourseStatus;
  q?: string;
}

export function listCourses(
  filters: CourseListFilters = {},
  signal?: AbortSignal,
): Promise<CourseListItem[]> {
  const query: Record<string, string> = {};
  if (filters.university_id) query.university_id = filters.university_id;
  if (filters.department) query.department = filters.department;
  if (filters.status) query.status = filters.status;
  if (filters.q) query.q = filters.q;
  return api.get<CourseListItem[]>("/api/courses", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}

export function getCourse(id: string, signal?: AbortSignal): Promise<CourseListItem> {
  return api.get<CourseListItem>(`/api/courses/${id}`, { signal });
}

export function createCourse(input: CreateCourseInput): Promise<CourseListItem> {
  return api.post<CourseListItem>("/api/courses", input);
}

export function updateCourse(
  id: string,
  input: UpdateCourseInput,
): Promise<CourseListItem | Course> {
  return api.patch<CourseListItem | Course>(`/api/courses/${id}`, input);
}

export function deleteCourse(id: string): Promise<{ id: string; deleted: boolean }> {
  return api.delete<{ id: string; deleted: boolean }>(`/api/courses/${id}`);
}

export function listCourseAssignments(
  courseId: string,
  signal?: AbortSignal,
): Promise<CourseAssignmentListItem[]> {
  return api.get<CourseAssignmentListItem[]>(
    `/api/courses/${courseId}/assignments`,
    { signal },
  );
}

export function createCourseAssignment(
  courseId: string,
  input: CreateCourseAssignmentInput,
): Promise<CourseAssignmentListItem> {
  return api.post<CourseAssignmentListItem>(
    `/api/courses/${courseId}/assignments`,
    input,
  );
}

export function deleteCourseAssignment(
  courseId: string,
  assignmentId: string,
): Promise<{ id: string; deleted: boolean }> {
  return api.delete<{ id: string; deleted: boolean }>(
    `/api/courses/${courseId}/assignments/${assignmentId}`,
  );
}
