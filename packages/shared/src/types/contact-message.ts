import type { CONTACT_MESSAGE_STATUSES } from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";

export type ContactMessageStatus = (typeof CONTACT_MESSAGE_STATUSES)[number];

export interface ContactMessage {
  id: Id;
  name: string;
  email: string;
  message: string;
  status: ContactMessageStatus;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}
