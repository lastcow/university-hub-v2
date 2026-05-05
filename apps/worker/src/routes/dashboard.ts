// Dashboard summary: counts for the protected /app/dashboard page, scoped
// to whatever the actor is allowed to see. Returns 200 for any authenticated
// user — the frontend renders the same three cards everywhere; the numbers
// shrink when the role can't see beyond their own university.
//
//   super_admin                      → global active counts
//   any role with a university_id    → counts within their own university
//                                      (universities = 1)
//   roles without a university_id    → zeros (e.g. an unaffiliated guest)

import type { DashboardSummary } from "@university-hub/shared";

import { queryFirst } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { jsonOk } from "../utils/responses.js";

interface CountRow extends Record<string, unknown> {
  c: number;
}

async function safeCount(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  try {
    const row = await queryFirst<CountRow>(db, sql, params);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function handleDashboardSummary(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  let universities = 0;
  let users = 0;
  let invitations = 0;

  if (actor.role === "super_admin") {
    [universities, users, invitations] = await Promise.all([
      safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM universities WHERE status = 'active'"),
      safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM users WHERE status = 'active'"),
      safeCount(ctx.env.DB, "SELECT COUNT(*) AS c FROM invitations WHERE status = 'pending'"),
    ]);
  } else if (actor.university_id) {
    [universities, users, invitations] = await Promise.all([
      safeCount(
        ctx.env.DB,
        "SELECT COUNT(*) AS c FROM universities WHERE status = 'active' AND id = ?",
        [actor.university_id],
      ),
      safeCount(
        ctx.env.DB,
        "SELECT COUNT(*) AS c FROM users WHERE status = 'active' AND university_id = ?",
        [actor.university_id],
      ),
      safeCount(
        ctx.env.DB,
        "SELECT COUNT(*) AS c FROM invitations WHERE status = 'pending' AND university_id = ?",
        [actor.university_id],
      ),
    ]);
  }

  const body: DashboardSummary = {
    universities,
    users,
    invitations,
    generated_at: new Date().toISOString(),
  };
  return jsonOk(body);
}
