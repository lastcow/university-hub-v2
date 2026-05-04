import type { Id, IsoDateString } from "./common.js";

export interface Student {
  id: Id;
  user_id: Id;
  university_id: Id;
  department_id: Id | null;
  student_number: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `Student` row joined with the underlying user + university/department names. */
export interface StudentListItem extends Student {
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}
