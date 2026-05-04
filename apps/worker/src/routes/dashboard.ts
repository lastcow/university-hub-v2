// Dashboard summary: placeholder counts for the protected /app/dashboard
// page. Real per-role / per-university aggregations land in later issues
// (UNI-11+); for now this just exercises the auth-protected wire path so the
// frontend can render its loading/empty/error states end-to-end.

import type { DashboardSummary } from "@university-hub/shared";

import { queryFirst } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { jsonOk } from "../utils/responses.js";

interface CountRow extends Record<string, unknown> {
  c: number;
}

async function safeCount(db: D1Database, sql: string): Promise<number> {
  try {
    const row = await queryFirst<CountRow>(db, sql);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function handleDashboardSummary(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;

  const [universities, users, invitations] = await Promise.all([
    safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM universities WHERE status = 'active'"),
    safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM users WHERE status = 'active'"),
    safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM invitations WHERE status = 'pending'"),
  ]);

  const body: DashboardSummary = {
    universities,
    users,
    invitations,
    generated_at: new Date().toISOString(),
  };
  return jsonOk(body);
}
