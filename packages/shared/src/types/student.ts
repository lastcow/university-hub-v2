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
