// Frontend client for assessments, grades, and the FERPA grade-access-log
// admin endpoint (UNI-30).

import type {
  AssessmentListItem,
  CreateAssessmentInput,
  CreateGradeInput,
  Grade,
  GradeAccessLogListResponse,
  GradebookEntry,
  StudentGradeEntry,
  UpdateAssessmentInput,
  UpdateGradeInput,
} from "@university-hub/shared";

import { api } from "./api";

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export function listCourseAssessments(
  courseId: string,
  signal?: AbortSignal,
): Promise<AssessmentListItem[]> {
  return api.get<AssessmentListItem[]>(
    `/api/courses/${courseId}/assessments`,
    { signal },
  );
}

export function createCourseAssessment(
  courseId: string,
  input: CreateAssessmentInput,
): Promise<AssessmentListItem> {
  return api.post<AssessmentListItem>(
    `/api/courses/${courseId}/assessments`,
    input,
  );
}

export function updateAssessment(
  id: string,
  input: UpdateAssessmentInput,
): Promise<AssessmentListItem> {
  return api.patch<AssessmentListItem>(`/api/assessments/${id}`, input);
}

export function deleteAssessment(
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return api.delete<{ id: string; deleted: boolean }>(
    `/api/assessments/${id}`,
  );
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export function listCourseGrades(
  courseId: string,
  signal?: AbortSignal,
): Promise<GradebookEntry[]> {
  return api.get<GradebookEntry[]>(`/api/courses/${courseId}/grades`, {
    signal,
  });
}

export function listStudentGrades(
  studentUserId: string,
  signal?: AbortSignal,
): Promise<StudentGradeEntry[]> {
  return api.get<StudentGradeEntry[]>(
    `/api/students/${studentUserId}/grades`,
    { signal },
  );
}

export function createGrade(input: CreateGradeInput): Promise<Grade> {
  return api.post<Grade>("/api/grades", input);
}

export function updateGrade(
  id: string,
  input: UpdateGradeInput,
): Promise<Grade> {
  return api.patch<Grade>(`/api/grades/${id}`, input);
}

// ---------------------------------------------------------------------------
// FERPA grade-access-log (admin)
// ---------------------------------------------------------------------------

export interface GradeAccessLogFilters {
  student_user_id?: string;
  viewer_user_id?: string;
  course_id?: string;
  university_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listGradeAccessLog(
  filters: GradeAccessLogFilters = {},
  signal?: AbortSignal,
): Promise<GradeAccessLogListResponse> {
  const query: Record<string, string | number> = {};
  if (filters.student_user_id) query.student_user_id = filters.student_user_id;
  if (filters.viewer_user_id) query.viewer_user_id = filters.viewer_user_id;
  if (filters.course_id) query.course_id = filters.course_id;
  if (filters.university_id) query.university_id = filters.university_id;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.limit !== undefined) query.limit = filters.limit;
  if (filters.offset !== undefined) query.offset = filters.offset;
  return api.get<GradeAccessLogListResponse>("/api/grade-access-log", {
    signal,
    query: Object.keys(query).length ? query : undefined,
  });
}
