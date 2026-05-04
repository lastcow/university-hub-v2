import type { EmailLogStatus } from "./email-log.js";
import type { INVITATION_STATUSES } from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";
import type { Role } from "./role.js";

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface Invitation {
  id: Id;
  email: string;
  role: Role;
  status: InvitationStatus;
  university_id: Id | null;
  invited_by: Id | null;
  expires_at: IsoDateString;
  accepted_at: IsoDateString | null;
  created_at: IsoDateString;
}

/**
 * Invitation row enriched with the latest email-delivery snapshot. The admin
 * `/app/invitations` page uses this so it can show send status + last-sent
 * date alongside the invitation row without a second round-trip per row.
 */
export interface InvitationListItem extends Invitation {
  invited_by_name: string | null;
  university_name: string | null;
  last_email_status: EmailLogStatus | null;
  last_email_sent_at: IsoDateString | null;
  last_email_error: string | null;
}

/** Public-shape returned when a visitor opens `/accept-invitation?token=…`. */
export type InvitationLookupResult =
  | {
      status: "valid";
      email: string;
      role: Role;
      university_id: Id | null;
      university_name: string | null;
      expires_at: IsoDateString;
    }
  | { status: "expired" }
  | { status: "accepted" }
  | { status: "revoked" }
  | { status: "invalid" };

/**
 * Body returned from `POST /api/invitations` when the invitation row is
 * created. `email_status` reflects the Mailgun result so the admin UI can
 * show "created but email failed" without a follow-up fetch.
 */
export interface InvitationCreateResult {
  invitation: Invitation;
  email_status: EmailLogStatus;
  email_error: string | null;
}

/** Body returned from `POST /api/invitations/accept` on success. */
export interface InvitationAcceptResult {
  user_id: Id;
  email: string;
  role: Role;
}
