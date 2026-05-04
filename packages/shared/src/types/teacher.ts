import type { Id, IsoDateString } from "./common.js";

export interface Teacher {
  id: Id;
  user_id: Id;
  university_id: Id;
  department_id: Id | null;
  title: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `Teacher` row joined with the underlying user + university/department names. */
export interface TeacherListItem extends Teacher {
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}
