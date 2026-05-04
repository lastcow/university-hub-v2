import type { Id, IsoDateString } from "./common.js";

export interface Assessment {
  id: Id;
  course_id: Id;
  title: string;
  description: string | null;
  weight: number;
  max_score: number;
  due_at: IsoDateString | null;
  created_by: Id | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `Assessment` enriched with course context for table rendering. */
export interface AssessmentListItem extends Assessment {
  course_name: string | null;
  course_code: string | null;
}
