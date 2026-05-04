import type { IsoDateString } from "./common.js";

export interface HealthResponse {
  ok: true;
  service: "university-hub-worker";
  timestamp: IsoDateString;
}
