import type { Id, IsoDateString } from "./common.js";

export interface TeacherAssistant {
  id: Id;
  user_id: Id;
  university_id: Id;
  department_id: Id | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `TeacherAssistant` row joined with the user + university/department names. */
export interface TeacherAssistantListItem extends TeacherAssistant {
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}
