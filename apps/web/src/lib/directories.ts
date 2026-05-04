// Frontend client for the academic directory APIs (UNI-13).
//
// Each role has the same shape: a list endpoint, a /me convenience endpoint,
// and a /:id detail endpoint. Teachers/TAs also expose nested /courses (and
// /students for teachers) — those use CourseListItem and StudentListItem so
// the dashboards can reuse the existing badge/table components.

import type {
  CourseListItem,
  FacultyListItem,
  StudentListItem,
  TeacherAssistantListItem,
  TeacherListItem,
} from "@university-hub/shared";

import { api } from "./api";

export interface DirectoryListFilters {
  q?: string;
  department?: string;
  university_id?: string;
}

function toQuery(filters: DirectoryListFilters): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (filters.q) out.q = filters.q;
  if (filters.department) out.department = filters.department;
  if (filters.university_id) out.university_id = filters.university_id;
  return Object.keys(out).length ? out : undefined;
}

// --- Students -------------------------------------------------------------

export function listStudents(
  filters: DirectoryListFilters = {},
  signal?: AbortSignal,
): Promise<StudentListItem[]> {
  return api.get<StudentListItem[]>("/api/students", {
    signal,
    query: toQuery(filters),
  });
}

export function getStudent(id: string, signal?: AbortSignal): Promise<StudentListItem> {
  return api.get<StudentListItem>(`/api/students/${id}`, { signal });
}

export function getMyStudent(signal?: AbortSignal): Promise<StudentListItem> {
  return api.get<StudentListItem>("/api/students/me", { signal });
}

export function listMyStudentCourses(signal?: AbortSignal): Promise<CourseListItem[]> {
  return api.get<CourseListItem[]>("/api/students/me/courses", { signal });
}

// --- Faculty --------------------------------------------------------------

export function listFaculty(
  filters: DirectoryListFilters = {},
  signal?: AbortSignal,
): Promise<FacultyListItem[]> {
  return api.get<FacultyListItem[]>("/api/faculty", {
    signal,
    query: toQuery(filters),
  });
}

export function getFaculty(id: string, signal?: AbortSignal): Promise<FacultyListItem> {
  return api.get<FacultyListItem>(`/api/faculty/${id}`, { signal });
}

// --- Teachers -------------------------------------------------------------

export function listTeachers(
  filters: DirectoryListFilters = {},
  signal?: AbortSignal,
): Promise<TeacherListItem[]> {
  return api.get<TeacherListItem[]>("/api/teachers", {
    signal,
    query: toQuery(filters),
  });
}

export function getTeacher(id: string, signal?: AbortSignal): Promise<TeacherListItem> {
  return api.get<TeacherListItem>(`/api/teachers/${id}`, { signal });
}

export function listTeacherCourses(
  id: string,
  signal?: AbortSignal,
): Promise<CourseListItem[]> {
  return api.get<CourseListItem[]>(`/api/teachers/${id}/courses`, { signal });
}

export function listTeacherStudents(
  id: string,
  signal?: AbortSignal,
): Promise<StudentListItem[]> {
  return api.get<StudentListItem[]>(`/api/teachers/${id}/students`, { signal });
}

export function getMyTeacher(signal?: AbortSignal): Promise<TeacherListItem> {
  return api.get<TeacherListItem>("/api/teachers/me", { signal });
}

export function listMyTeacherCourses(
  signal?: AbortSignal,
): Promise<CourseListItem[]> {
  return api.get<CourseListItem[]>("/api/teachers/me/courses", { signal });
}

export function listMyTeacherStudents(
  signal?: AbortSignal,
): Promise<StudentListItem[]> {
  return api.get<StudentListItem[]>("/api/teachers/me/students", { signal });
}

// --- Teacher assistants ---------------------------------------------------

export function listTeacherAssistants(
  filters: DirectoryListFilters = {},
  signal?: AbortSignal,
): Promise<TeacherAssistantListItem[]> {
  return api.get<TeacherAssistantListItem[]>("/api/teacher-assistants", {
    signal,
    query: toQuery(filters),
  });
}

export function getTeacherAssistant(
  id: string,
  signal?: AbortSignal,
): Promise<TeacherAssistantListItem> {
  return api.get<TeacherAssistantListItem>(`/api/teacher-assistants/${id}`, {
    signal,
  });
}

export function listTeacherAssistantCourses(
  id: string,
  signal?: AbortSignal,
): Promise<CourseListItem[]> {
  return api.get<CourseListItem[]>(
    `/api/teacher-assistants/${id}/courses`,
    { signal },
  );
}

export function getMyTeacherAssistant(
  signal?: AbortSignal,
): Promise<TeacherAssistantListItem> {
  return api.get<TeacherAssistantListItem>("/api/teacher-assistants/me", {
    signal,
  });
}

export function listMyTeacherAssistantCourses(
  signal?: AbortSignal,
): Promise<CourseListItem[]> {
  return api.get<CourseListItem[]>("/api/teacher-assistants/me/courses", {
    signal,
  });
}
