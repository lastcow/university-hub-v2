import type { Id, IsoDateString } from "./common.js";

export interface Department {
  id: Id;
  university_id: Id;
  name: string;
  code: string | null;
  description: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}
