import type { EmailLogStatus } from "./email-log.js";
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

/**
 * `User` row enriched with the university name for table rendering. Used by
 * `GET /api/users` so the admin table doesn't need a second lookup per row.
 */
export interface UserListItem extends User {
  university_name: string | null;
}

/**
 * Response from `PATCH /api/users/:id/status`. Mirrors `InvitationCreateResult`:
 * the row is always returned, plus the email-delivery outcome for the
 * status-change notification (Mailgun may be unconfigured in dev/prod, in which
 * case the row still updates but the email logs as `failed`).
 */
export interface UserStatusChangeResult {
  user: UserListItem;
  email_status: EmailLogStatus;
  email_error: string | null;
}
