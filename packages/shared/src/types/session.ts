import type { Id, IsoDateString } from "./common.js";

/**
 * One row in the active-sessions list for the calling user (UNI-26). The
 * Worker truncates IPs and trims user-agents to keep the surface low-PII;
 * `is_current` flags the session whose cookie is on the request.
 */
export interface SessionListItem {
  id: Id;
  started_at: IsoDateString;
  last_activity_at: IsoDateString;
  ip_excerpt: string | null;
  user_agent_excerpt: string | null;
  is_current: boolean;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
  idle_timeout_seconds: number;
  absolute_timeout_seconds: number;
}

export interface SessionRevokeAllResponse {
  revoked_count: number;
}
