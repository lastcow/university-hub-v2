import type { IsoDateString } from "./common.js";

export interface DashboardSummary {
  universities: number;
  users: number;
  invitations: number;
  generated_at: IsoDateString;
}
