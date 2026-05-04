// Frontend client for the faculty course-analytics endpoints (UNI-31).

import type {
  AssessmentAnalyticsSummary,
  CourseAnalyticsSummary,
} from "@university-hub/shared";

import { api } from "./api";

export function getCourseAnalyticsSummary(
  courseId: string,
  signal?: AbortSignal,
): Promise<CourseAnalyticsSummary> {
  return api.get<CourseAnalyticsSummary>(
    `/api/courses/${courseId}/analytics/summary`,
    { signal },
  );
}

export function getAssessmentAnalyticsSummary(
  courseId: string,
  assessmentId: string,
  signal?: AbortSignal,
): Promise<AssessmentAnalyticsSummary> {
  return api.get<AssessmentAnalyticsSummary>(
    `/api/courses/${courseId}/analytics/assessment/${assessmentId}`,
    { signal },
  );
}
