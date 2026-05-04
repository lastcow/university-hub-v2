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

/** `Department` row enriched with denormalized fields for table rendering. */
export interface DepartmentListItem extends Department {
  university_name: string | null;
  course_count: number;
}
