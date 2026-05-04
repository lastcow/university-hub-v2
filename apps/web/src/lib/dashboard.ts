import type { DashboardSummary } from "@university-hub/shared";

import { api } from "./api";

export function fetchDashboardSummary(
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  return api.get<DashboardSummary>("/api/dashboard/summary", { signal });
}
