import type { GRADE_STATUSES } from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";

export type GradeStatus = (typeof GRADE_STATUSES)[number];

export interface Grade {
  id: Id;
  assessment_id: Id;
  student_user_id: Id;
  score: number | null;
  letter_grade: string | null;
  feedback: string | null;
  status: GradeStatus;
  graded_by_user_id: Id | null;
  graded_at: IsoDateString | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/**
 * Gradebook row — one entry in the faculty/teacher view.
 */
export interface GradebookEntry extends Grade {
  student_name: string;
  student_email: string;
  assessment_title: string;
  assessment_max_score: number;
  course_id: Id;
}

/**
 * Student-self grade row.
 */
export interface StudentGradeEntry extends Grade {
  course_id: Id;
  course_name: string | null;
  course_code: string | null;
  assessment_title: string;
  assessment_max_score: number;
  assessment_weight: number;
  assessment_due_at: IsoDateString | null;
}

export interface GradeAccessLogEntry {
  id: Id;
  viewer_user_id: Id | null;
  viewer_name: string | null;
  viewer_email: string | null;
  viewer_role: string;
  viewer_course_role: string | null;
  course_id: Id | null;
  course_name: string | null;
  assessment_id: Id | null;
  assessment_title: string | null;
  viewed_grade_id: Id | null;
  viewed_student_user_id: Id | null;
  viewed_student_name: string | null;
  viewed_student_email: string | null;
  context: string;
  accessed_at: IsoDateString;
}

export interface GradeAccessLogListResponse {
  items: GradeAccessLogEntry[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
