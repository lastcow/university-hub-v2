import type { USER_STATUSES } from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";
import type { Role } from "./role.js";

export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  university_id: Id | null;
  last_sign_in_at: IsoDateString | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

export interface SessionUser {
  id: Id;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  university_id: Id | null;
}
