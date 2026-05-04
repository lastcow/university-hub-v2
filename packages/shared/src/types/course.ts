import type {
  COURSE_ASSIGNMENT_ROLES,
  COURSE_STATUSES,
} from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";
import type { Role } from "./role.js";

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

/** `Course` row enriched for table rendering. */
export interface CourseListItem extends Course {
  university_name: string | null;
  department_name: string | null;
  assignment_count: number;
}

export interface CourseAssignment {
  id: Id;
  course_id: Id;
  user_id: Id;
  role: CourseAssignmentRole;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `CourseAssignment` enriched with the user's display fields. */
export interface CourseAssignmentListItem extends CourseAssignment {
  user_name: string;
  user_email: string;
  user_role: Role;
}
