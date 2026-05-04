import type {
  EMAIL_LOG_STATUSES,
  EMAIL_TYPES,
} from "../constants/statuses.js";
import type { Id, IsoDateString } from "./common.js";

export type EmailType = (typeof EMAIL_TYPES)[number];

export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number];

export interface EmailLog {
  id: Id;
  university_id: Id | null;
  recipient_email: string;
  type: EmailType;
  template_name: string | null;
  status: EmailLogStatus;
  mailgun_message_id: string | null;
  error: string | null;
  related_entity_type: string | null;
  related_entity_id: Id | null;
  created_at: IsoDateString;
}

/**
 * Row returned by `GET /api/email-logs`. Includes the joined university name
 * so the admin table doesn't need a second lookup per row.
 */
export interface EmailLogListItem extends EmailLog {
  university_name: string | null;
}

export interface EmailLogListResponse {
  items: EmailLogListItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
