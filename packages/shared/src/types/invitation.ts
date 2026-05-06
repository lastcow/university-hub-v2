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

/**
 * Body returned from `POST /api/invitations/accept` on success.
 *
 * UNI-60: the endpoint no longer mints a session cookie here. UNI-49
 * made MFA enrollment mandatory for every authenticated role, and
 * auto-signing the new user in let them skip past it — leaving them
 * stuck in a sign-in ↔ "Sign in again to complete MFA verification"
 * loop on their next sign-in (no `mfa_secret` to satisfy a TOTP
 * challenge). The accept endpoint now sets an MFA challenge cookie and
 * returns `mfa_enrollment_required: true`; the SPA pivots straight to
 * the MFA-enroll step on the sign-in page, where verify-enroll mints
 * the real session after the first TOTP code is accepted.
 */
export interface InvitationAcceptResult {
  user_id: Id;
  email: string;
  role: Role;
  /**
   * Always `true` today (UNI-49 makes MFA mandatory for every role).
   * Surfaced as a discriminator so the SPA can branch and so a future
   * per-role exemption can land without changing the response shape.
   */
  mfa_enrollment_required: true;
  /**
   * Mirrors `SignInResponse.trusted_device_eligible` — `true` for every
   * role except `super_admin`. The SPA threads this through to the
   * MFA challenge surface so the "Trust this device" checkbox stays in
   * sync between the invitation-accept flow and the regular sign-in
   * flow.
   */
  trusted_device_eligible: boolean;
  /**
   * UNI-68: short-lived (5 min) MFA challenge token. Mirrors
   * `SignInResponse.mfa_challenge_token` so the post-accept enrollment
   * surface can pass it as `X-Mfa-Challenge-Token` on the follow-up
   * `/api/auth/mfa/{enroll,verify-enroll}` calls without depending on
   * the cross-site HttpOnly cookie surviving the Pages → Worker hop.
   */
  mfa_challenge_token: string;
}
