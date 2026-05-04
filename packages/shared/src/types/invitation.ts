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
