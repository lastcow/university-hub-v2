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

/**
 * Response from `DELETE /api/users/:id` (UNI-61). The post-delete row is
 * returned in its anonymized form so the SPA can refresh its cache and
 * re-render the user as `Removed User #N` without a follow-up GET.
 *
 * `idempotent` is true when the call was a no-op because the user was
 * already removed — the row in `user` is the existing anonymized row,
 * unchanged. Distinguishing this from a fresh deletion lets the SPA tell
 * the operator "Already removed" instead of celebrating a duplicate
 * destructive action.
 */
export interface DeleteUserResult {
  user: UserListItem;
  idempotent: boolean;
}

/**
 * Returns the name to show for a user in any UI surface. When the user is
 * a "removed" tombstone (UNI-61 anonymization), we replace their actual
 * `name` (which is itself already anonymized to "Removed User #N" but may
 * leak through joins in older audit rows) with a stable display string
 * derived from the row's `id`. Pre-anonymized rows are returned as-is.
 *
 * The numeric suffix is the first 8 hex chars of the UUID. It's short
 * enough to render in a table cell, stable across renders, and never
 * collides because UUIDs themselves don't.
 */
export function displayUserName(
  user: { id: Id; name: string; status: UserStatus },
): string {
  if (user.status === "deleted") {
    const suffix = user.id.replace(/-/g, "").slice(0, 8);
    return `Removed User #${suffix}`;
  }
  return user.name;
}
