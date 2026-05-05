// Post-MFA onboarding hooks (epic UNI-50 / sub-issue UNI-57).
//
//   GET    /api/onboarding/lms-step     evaluate eligibility for the
//                                       one-time "Connect your LMS" step.
//   POST   /api/onboarding/lms-step/dismiss
//                                       stamp `users.lms_onboarding_dismissed_at`
//                                       so the step never reappears.
//
// Both endpoints are gated to authenticated users only; tenant scoping is
// implicit because the work is scoped to the calling user's own row.
//
// The four gates are evaluated server-side rather than in the SPA so the
// SPA can stay dumb: it always calls `GET /api/onboarding/lms-step` after
// MFA verify and routes to `/app/onboarding/lms` only when `show === true`.
// Any drift between the gating rules and the page contents lives in one
// place.

import {
  type DismissLmsOnboardingResponse,
  type LmsConnectionStatus,
  type LmsEnabledProvider,
  type LmsOnboardingSkipReason,
  type LmsOnboardingStepResponse,
  type LmsProviderId,
  type Role,
  LMS_PROVIDER_DISPLAY_NAMES,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// Roles that can teach a course on an LMS. Students / staff / guests /
// viewers don't drive a Canvas course, so we never bother them with the
// connect step. `super_admin` and `university_admin` are also excluded —
// admins manage the per-university OAuth client config, not their own
// personal Canvas account, so the step would be a category error.
const TEACHING_ROLES: ReadonlySet<Role> = new Set([
  "faculty",
  "teacher",
  "teacher_assistant",
]);

interface ProviderConfigRow extends Row {
  provider_id: LmsProviderId;
  base_url: string;
  enabled: number;
}

interface ConnectionStatusRow extends Row {
  status: LmsConnectionStatus;
}

interface UserOnboardingRow extends Row {
  lms_onboarding_dismissed_at: string | null;
}

async function loadEnabledProvidersForUniversity(
  db: D1Database,
  universityId: string,
): Promise<ProviderConfigRow[]> {
  return queryAll<ProviderConfigRow>(
    db,
    `SELECT provider_id, base_url, enabled
       FROM lms_provider_configs
      WHERE university_id = ? AND enabled = 1
      ORDER BY provider_id ASC`,
    [universityId],
  );
}

async function userHasActiveConnection(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const row = await queryFirst<ConnectionStatusRow>(
    db,
    `SELECT status FROM lms_connections
      WHERE user_id = ? AND status = 'active'
      LIMIT 1`,
    [userId],
  );
  return row !== null;
}

async function loadUserOnboarding(
  db: D1Database,
  userId: string,
): Promise<UserOnboardingRow | null> {
  return queryFirst<UserOnboardingRow>(
    db,
    `SELECT lms_onboarding_dismissed_at FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
}

function skip(
  reason: LmsOnboardingSkipReason,
): LmsOnboardingStepResponse {
  return { show: false, reason, providers: [] };
}

// ---------------------------------------------------------------------------
// GET /api/onboarding/lms-step
// ---------------------------------------------------------------------------

export async function handleGetOnboardingLmsStep(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!TEACHING_ROLES.has(actor.role)) {
    return jsonOk<LmsOnboardingStepResponse>(skip("ineligible_role"));
  }
  if (!actor.university_id) {
    return jsonOk<LmsOnboardingStepResponse>(skip("no_university"));
  }

  // The dismissed-at column lives on `users`. We re-read instead of
  // trusting the in-memory UserRow because the auth middleware caches
  // the row from the request's session resolve, and a parallel write
  // (e.g. callback success in another tab) could already have stamped
  // it since this request started.
  const userRow = await loadUserOnboarding(ctx.env.DB, actor.id);
  if (userRow?.lms_onboarding_dismissed_at) {
    return jsonOk<LmsOnboardingStepResponse>(skip("dismissed"));
  }

  if (await userHasActiveConnection(ctx.env.DB, actor.id)) {
    return jsonOk<LmsOnboardingStepResponse>(skip("already_connected"));
  }

  const configs = await loadEnabledProvidersForUniversity(
    ctx.env.DB,
    actor.university_id,
  );
  if (configs.length === 0) {
    return jsonOk<LmsOnboardingStepResponse>(skip("no_provider_enabled"));
  }

  const providers: LmsEnabledProvider[] = configs.map((row) => ({
    provider_id: row.provider_id,
    display_name: LMS_PROVIDER_DISPLAY_NAMES[row.provider_id],
    base_url: row.base_url,
  }));

  return jsonOk<LmsOnboardingStepResponse>({
    show: true,
    providers,
  });
}

// ---------------------------------------------------------------------------
// POST /api/onboarding/lms-step/dismiss
// ---------------------------------------------------------------------------

export async function handleDismissOnboardingLmsStep(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Idempotent: if the user already dismissed (or successfully connected,
  // which also stamps this column on the OAuth callback path), echo the
  // existing value instead of overwriting it. Two reasons:
  //   1. Audit hygiene — the timestamp should reflect the FIRST dismiss
  //      (or connect), not a second click that was a no-op.
  //   2. We still want to write the audit row for the second click so
  //      post-incident review can see "user clicked Skip again from a
  //      stale tab", which is otherwise silent.
  const existing = await loadUserOnboarding(ctx.env.DB, actor.id);
  const existingTs = existing?.lms_onboarding_dismissed_at ?? null;
  const now = new Date().toISOString();
  const dismissedAt = existingTs ?? now;

  if (existingTs === null) {
    await execute(
      ctx.env.DB,
      `UPDATE users
          SET lms_onboarding_dismissed_at = ?,
              updated_at = ?
        WHERE id = ?`,
      [dismissedAt, now, actor.id],
    );
  }

  await writeAuditLog(ctx.env.DB, {
    action: "lms.onboarding.dismissed",
    actorUserId: actor.id,
    universityId: actor.university_id,
    entityType: "user",
    entityId: actor.id,
    metadata: {
      via: "skip_button",
      already_dismissed: existingTs !== null,
    },
  });

  return jsonOk<DismissLmsOnboardingResponse>({
    ok: true,
    dismissed_at: dismissedAt,
  });
}
