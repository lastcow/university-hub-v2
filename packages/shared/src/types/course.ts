import type {
  COURSE_ASSIGNMENT_ROLES,
  COURSE_STATUSES,
} from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";

export type CourseStatus = (typeof COURSE_STATUSES)[number];

export type CourseAssignmentRole = (typeof COURSE_ASSIGNMENT_ROLES)[number];

export interface Course {
  id: Id;
  university_id: Id;
  department_id: Id | null;
  name: string;
  code: string | null;
  description: string | null;
  status: CourseStatus;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

export interface CourseAssignment {
  id: Id;
  course_id: Id;
  user_id: Id;
  role: CourseAssignmentRole;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}
