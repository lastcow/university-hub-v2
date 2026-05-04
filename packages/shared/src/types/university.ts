import type { UNIVERSITY_STATUSES } from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";

export type UniversityStatus = (typeof UNIVERSITY_STATUSES)[number];

export interface University {
  id: Id;
  name: string;
  slug: string | null;
  status: UniversityStatus;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}
