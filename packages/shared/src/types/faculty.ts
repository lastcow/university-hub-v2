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
