import type { Id, IsoDateString } from "./common.js";

export interface Faculty {
  id: Id;
  user_id: Id;
  university_id: Id;
  department_id: Id | null;
  title: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `Faculty` row joined with the underlying user + university/department names. */
export interface FacultyListItem extends Faculty {
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}
