// Sync orchestration routes (epic UNI-50 / sub-issue UNI-55).
//
//   GET    /api/lms/connections/:id/terms        proxy to provider.listTerms.
//   POST   /api/lms/sync-runs/preview            read-only preview counts.
//   POST   /api/lms/sync-runs                    create row, schedule runner,
//                                                return sync_run_id.
//   GET    /api/lms/sync-runs/:id                current state for UI polling.
//   GET    /api/lms/sync-runs                    caller's last 20 runs.
//
// All endpoints require an authenticated session and a connection that
// belongs to the calling user. Cross-user access is cloaked as 404 to
// match the precedent set by the disconnect handler in UNI-54.
//
// The runner now drives the real reconciliation engine landed in
// UNI-56 (`apps/worker/src/lms/reconcile.ts`). The route's
// `runReconciliationForRun` function persists the engine's progress
// callbacks into `summary_json.progress`, and writes the terminal row
// (`success` / `partial` / `failed`) once the engine returns.
//
// `lms_sync_runs.term_id` carries the provider-native term id (e.g.
// Canvas's `enrollment_term_id`) — the SPA's term picker emits it
// straight, the reconciliation engine consumes it as the term cursor.
// 0015's original schema modelled the column as a FK into the local
// `terms` catalog; UNI-66 dropped that FK (migration 0023) because the
// runtime never populated `terms` rows on sync, and every sync-run
// INSERT was failing with SQLITE_CONSTRAINT_FOREIGNKEY.

import {
  type CreateLmsSyncRunResponse,
  type LmsConnectionStatus,
  type LmsConnectionTermsResponse,
  type LmsProviderId,
  type LmsSyncConflict,
  type LmsSyncError,
  type LmsSyncPreviewResponse,
  type LmsSyncRunProgress,
  type LmsSyncRunPublic,
  type LmsSyncRunResponse,
  type LmsSyncRunStatus,
  type LmsSyncRunsResponse,
  type LmsSyncSummary,
  type LmsTerm,
  lmsSyncRunInputSchema,
} from "@university-hub/shared";

import { decryptForUniversity } from "../crypto/field-encryption.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import type { LmsConnection } from "@university-hub/shared";
import { lmsProviderRegistry } from "../lms/index.js";
import { runLmsReconciliation } from "../lms/reconcile.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// Module-level term cache. Light caching only — Canvas's "list terms"
// endpoint is per-tenant and the data drifts on the order of academic
// terms, not seconds. A 60s TTL is enough to absorb the common case
// (user opens the modal, picks a term, runs preview, kicks off the
// sync — four round-trips that share a term list).
const TERMS_CACHE_TTL_MS = 60 * 1000;
interface TermsCacheEntry {
  expires_at: number;
  payload: LmsTerm[];
}
const termsCache = new Map<string, TermsCacheEntry>();
function termsCacheKey(connectionId: string): string {
  // Keyed on connection id — every (user, provider) pair has its own
  // entry, so a refresh by one user cannot poison another's view.
  return connectionId;
}
/** Test seam: tests that exercise the terms route across cases need to
 *  invalidate the cache without mutating a private. Production callers
 *  rely on the TTL. */
export function __resetLmsTermsCacheForTest(): void {
  termsCache.clear();
}

interface ConnectionRow extends Row {
  id: string;
  user_id: string;
  university_id: string;
  provider_id: LmsProviderId;
  base_url: string;
  access_token_encrypted: string;
  external_user_id: string | null;
  status: LmsConnectionStatus;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncRunRow extends Row {
  id: string;
  user_id: string;
  connection_id: string;
  term_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: LmsSyncRunStatus;
  summary_json: string | null;
  error_log_json: string | null;
}

const SELECT_CONNECTION = `
  SELECT id, user_id, university_id, provider_id, base_url,
         access_token_encrypted, external_user_id, status, last_synced_at,
         created_at, updated_at
    FROM lms_connections
`;

const SELECT_SYNC_RUN = `
  SELECT id, user_id, connection_id, term_id,
         started_at, completed_at, status,
         summary_json, error_log_json
    FROM lms_sync_runs
`;

async function loadConnectionById(
  db: D1Database,
  id: string,
): Promise<ConnectionRow | null> {
  return queryFirst<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE id = ?`,
    [id],
  );
}

async function loadSyncRunById(
  db: D1Database,
  id: string,
): Promise<SyncRunRow | null> {
  return queryFirst<SyncRunRow>(
    db,
    `${SELECT_SYNC_RUN} WHERE id = ?`,
    [id],
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Decrypt a connection row's access token (PAT) and reshape into the
 *  substrate `LmsConnection` the provider methods accept. The plaintext
 *  lives only in the returned object's closure for the duration of the
 *  route handler — never logged, never returned to the SPA, never
 *  rewritten to D1. */
async function rowToLmsConnection(
  ctx: RequestContext,
  row: ConnectionRow,
): Promise<LmsConnection> {
  const accessToken = await decryptForUniversity(
    ctx.env,
    row.access_token_encrypted,
    row.university_id,
  );
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    provider_id: row.provider_id,
    base_url: row.base_url,
    access_token: accessToken,
    external_user_id: row.external_user_id,
    status: row.status,
    last_synced_at:
      (row.last_synced_at ?? null) as LmsConnection["last_synced_at"],
    created_at: row.created_at as LmsConnection["created_at"],
    updated_at: row.updated_at as LmsConnection["updated_at"],
  };
}

/** Mark the connection row `expired` after a 401 from Canvas. The user
 *  re-pastes a fresh PAT in /app/integrations to recover; we keep the
 *  row (and metadata like `last_synced_at`) so the UI shows the prior
 *  state alongside the "Expired" badge. */
async function markConnectionExpired(
  ctx: RequestContext,
  connectionId: string,
): Promise<void> {
  try {
    await execute(
      ctx.env.DB,
      `UPDATE lms_connections
          SET status = 'expired', updated_at = ?
        WHERE id = ?`,
      [new Date().toISOString(), connectionId],
    );
  } catch (cause) {
    console.warn("lms_connection_expire_write_failed", {
      connection_id: connectionId,
      cause,
    });
  }
}

/** Detect 401-from-Canvas in a thrown error chain. We accept either
 *  `CanvasApiError` shape (the api.ts helpers throw this directly) or
 *  a duck-typed `{ status: 401 }` wrapper (the reconciliation engine
 *  surfaces error rows that the runner wraps). */
function isCanvasUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 401;
}

/** Look up an active connection by id and confirm the caller owns it.
 *  Returns either the row or a Response (404 cloak / 409 not-active).
 *  The cloak matches the disconnect handler so a non-owner cannot
 *  distinguish "no such row" from "not yours". */
async function loadOwnedActiveConnectionOr404(
  ctx: RequestContext,
  actorUserId: string,
  connectionId: string,
): Promise<ConnectionRow | Response> {
  const row = await loadConnectionById(ctx.env.DB, connectionId);
  if (!row || row.user_id !== actorUserId) {
    return errorResponse(404, "not_found", "Connection not found.");
  }
  if (row.status !== "active") {
    return errorResponse(
      409,
      "connection_not_active",
      "This LMS connection is no longer active. Reconnect from /app/integrations and try again.",
    );
  }
  return row;
}

function syncRowToPublic(row: SyncRunRow): LmsSyncRunPublic {
  const parsedSummary = parseSummaryJson(row.summary_json);
  return {
    id: row.id,
    user_id: row.user_id,
    connection_id: row.connection_id,
    term_id: row.term_id,
    term_name: parsedSummary.term_name,
    started_at: row.started_at as LmsSyncRunPublic["started_at"],
    completed_at:
      (row.completed_at ?? null) as LmsSyncRunPublic["completed_at"],
    status: row.status,
    summary: parsedSummary.summary,
    errors: parseErrorsJson(row.error_log_json),
    conflicts: parsedSummary.conflicts,
    progress: parsedSummary.progress,
  };
}

interface ParsedSummary {
  summary: LmsSyncSummary | null;
  progress: LmsSyncRunProgress | null;
  term_name: string | null;
  conflicts: LmsSyncConflict[] | null;
}

/** `summary_json` carries four logical fields packed into one column
 *  to keep the schema unchanged from UNI-51:
 *
 *    - `summary`    : final per-run counts (UNI-56's reconciliation
 *                     engine fills these).
 *    - `progress`   : in-flight progress signal for UI polling.
 *    - `term_name`  : display label captured at run-start so the UI
 *                     doesn't have to re-fetch the term list to render
 *                     the run history.
 *    - `conflicts`  : non-error advisories from the engine — courses
 *                     with manual edits since last sync (LMS still
 *                     wins; the UI surfaces these as warnings).
 *
 *  Unknown / malformed JSON is treated as null on every field so a
 *  hand-edited row doesn't crash the route. */
function parseSummaryJson(raw: string | null): ParsedSummary {
  if (!raw) {
    return { summary: null, progress: null, term_name: null, conflicts: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { summary: null, progress: null, term_name: null, conflicts: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { summary: null, progress: null, term_name: null, conflicts: null };
  }
  const obj = parsed as Record<string, unknown>;
  const summary = obj.summary && typeof obj.summary === "object"
    ? (obj.summary as LmsSyncSummary)
    : null;
  const progress = obj.progress && typeof obj.progress === "object"
    ? normaliseProgress(obj.progress as Record<string, unknown>)
    : null;
  const term_name = typeof obj.term_name === "string" ? obj.term_name : null;
  const conflicts = Array.isArray(obj.conflicts)
    ? (obj.conflicts as LmsSyncConflict[])
    : null;
  return { summary, progress, term_name, conflicts };
}

function normaliseProgress(
  obj: Record<string, unknown>,
): LmsSyncRunProgress | null {
  const current = typeof obj.current_step === "number" ? obj.current_step : null;
  const total = typeof obj.total_steps === "number" ? obj.total_steps : null;
  if (current === null || total === null) return null;
  const label = typeof obj.label === "string" ? obj.label : null;
  return { current_step: current, total_steps: total, label };
}

function parseErrorsJson(raw: string | null): LmsSyncError[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LmsSyncError[];
    return null;
  } catch {
    return null;
  }
}

function buildSummaryJson(input: {
  summary: LmsSyncSummary | null;
  progress: LmsSyncRunProgress | null;
  term_name: string | null;
  conflicts?: LmsSyncConflict[] | null;
}): string {
  return JSON.stringify({
    summary: input.summary,
    progress: input.progress,
    term_name: input.term_name,
    conflicts: input.conflicts ?? null,
  });
}

// ---------------------------------------------------------------------------
// GET /api/lms/connections/:id/terms
// ---------------------------------------------------------------------------

export async function handleListLmsConnectionTerms(
  ctx: RequestContext,
  connectionId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const connRow = await loadOwnedActiveConnectionOr404(
    ctx,
    actor.id,
    connectionId,
  );
  if (connRow instanceof Response) return connRow;

  const provider = lmsProviderRegistry.get(connRow.provider_id);
  if (!provider) {
    return errorResponse(
      503,
      "provider_unavailable",
      `LMS provider '${connRow.provider_id}' is not registered on this build.`,
    );
  }

  const cached = termsCache.get(termsCacheKey(connRow.id));
  if (cached && cached.expires_at > Date.now()) {
    return jsonOk<LmsConnectionTermsResponse>({
      provider_id: connRow.provider_id,
      terms: cached.payload,
    });
  }

  let connection: LmsConnection;
  try {
    connection = await rowToLmsConnection(ctx, connRow);
  } catch (cause) {
    console.error("lms_terms_decrypt_failed", { cause });
    return errorResponse(
      500,
      "internal_error",
      "Could not unwrap the LMS access token. Reconnect from /app/integrations and try again.",
    );
  }

  let terms: LmsTerm[];
  try {
    terms = await provider.listTerms(connection);
  } catch (cause) {
    console.error("lms_terms_fetch_failed", {
      provider: connRow.provider_id,
      cause,
    });
    if (isCanvasUnauthorized(cause)) {
      await markConnectionExpired(ctx, connRow.id);
      return errorResponse(
        401,
        "lms_token_expired",
        "Your Canvas access token has been revoked or expired. Re-paste a new one in /app/integrations and try again.",
      );
    }
    return errorResponse(
      502,
      "lms_upstream_error",
      "The LMS could not return your term list. Try again in a moment.",
    );
  }

  termsCache.set(termsCacheKey(connRow.id), {
    expires_at: Date.now() + TERMS_CACHE_TTL_MS,
    payload: terms,
  });

  return jsonOk<LmsConnectionTermsResponse>({
    provider_id: connRow.provider_id,
    terms,
  });
}

// ---------------------------------------------------------------------------
// POST /api/lms/sync-runs/preview
// ---------------------------------------------------------------------------

export async function handleLmsSyncRunPreview(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const body = await readJson(ctx.request);
  const parsed = lmsSyncRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid sync-run preview body.",
      { issues: parsed.error.flatten() },
    );
  }
  const input = parsed.data;

  const connRow = await loadOwnedActiveConnectionOr404(
    ctx,
    actor.id,
    input.connection_id,
  );
  if (connRow instanceof Response) return connRow;

  const provider = lmsProviderRegistry.get(connRow.provider_id);
  if (!provider) {
    return errorResponse(
      503,
      "provider_unavailable",
      `LMS provider '${connRow.provider_id}' is not registered on this build.`,
    );
  }

  let connection: LmsConnection;
  try {
    connection = await rowToLmsConnection(ctx, connRow);
  } catch (cause) {
    console.error("lms_preview_decrypt_failed", { cause });
    return errorResponse(
      500,
      "internal_error",
      "Could not unwrap the LMS access token. Reconnect and try again.",
    );
  }

  let courses;
  try {
    courses = await provider.listMyCourses(connection, input.term_id);
  } catch (cause) {
    console.error("lms_preview_courses_failed", { cause });
    if (isCanvasUnauthorized(cause)) {
      await markConnectionExpired(ctx, connRow.id);
      return errorResponse(
        401,
        "lms_token_expired",
        "Your Canvas access token has been revoked or expired. Re-paste a new one in /app/integrations and try again.",
      );
    }
    return errorResponse(
      502,
      "lms_upstream_error",
      "The LMS could not return your course list for this term. Try again in a moment.",
    );
  }

  // Aggregate enrollments — first call per course only, per the issue
  // spec ("first page of listEnrollments per course"). Our existing
  // `listEnrollments` follows pagination internally; for the preview
  // surface we accept the cost since Phase 1 universities are small.
  // If the listing fails for a single course we record a 0 and keep
  // going — the count is an estimate, not a contract.
  //
  // `students_total` is the count of UNIQUE students across all
  // courses, not the sum of per-course rows: a student in three
  // courses is one student (UNI-67 follow-up — user explicit:
  // "students needs to pull from all courses, consider one student may
  // register multiple classes"). Dedup is by Canvas user_id, which
  // every enrollment row carries even when the bulk listing redacts
  // email/login_id (FERPA-strict tenants).
  const studentUserIds = new Set<string>();
  const studentEmails = new Set<string>();
  const courseExternalIds: string[] = [];
  let truncated = false;
  for (const course of courses) {
    courseExternalIds.push(course.external_id);
    let rows;
    try {
      rows = await provider.listEnrollments(connection, course.external_id);
    } catch (cause) {
      console.warn("lms_preview_enrollments_failed", {
        course_external_id: course.external_id,
        cause,
      });
      truncated = true;
      continue;
    }
    for (const enr of rows) {
      if (enr.role !== "student") continue;
      studentUserIds.add(enr.external_user_id);
      if (enr.email) studentEmails.add(enr.email.toLowerCase());
    }
  }
  const studentsTotal = studentUserIds.size;

  // Estimate "new" rows via the sources of truth that already shipped
  // in UNI-51:
  //   - courses_new_estimate: how many of the LMS courses don't yet
  //     have a Hub row keyed on (external_provider, external_id).
  //   - students_new_estimate: how many distinct enrolled emails are
  //     not yet in `users` for this university.
  let coursesNewEstimate = 0;
  if (courseExternalIds.length > 0) {
    coursesNewEstimate = await countNewCourses(
      ctx.env.DB,
      connRow.provider_id,
      courseExternalIds,
    );
  }
  let studentsNewEstimate = 0;
  if (studentEmails.size > 0) {
    studentsNewEstimate = await countNewUsersByEmail(
      ctx.env.DB,
      connRow.university_id,
      Array.from(studentEmails),
    );
  }

  const termName = await resolveTermNameFromCache(connRow.id, input.term_id);

  const response: LmsSyncPreviewResponse = {
    connection_id: connRow.id,
    term_id: input.term_id,
    term_name: termName,
    courses: courses.length,
    students_total: studentsTotal,
    students_new_estimate: studentsNewEstimate,
    courses_new_estimate: coursesNewEstimate,
    truncated,
  };
  return jsonOk(response);
}

async function countNewCourses(
  db: D1Database,
  providerId: LmsProviderId,
  externalIds: string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const placeholders = externalIds.map(() => "?").join(", ");
  const sql = `
    SELECT external_id
      FROM courses
     WHERE external_provider = ?
       AND external_id IN (${placeholders})
  `;
  const rows = await queryAll<{ external_id: string }>(db, sql, [
    providerId,
    ...externalIds,
  ]);
  const seen = new Set(rows.map((r) => r.external_id));
  let newCount = 0;
  for (const id of externalIds) {
    if (!seen.has(id)) newCount += 1;
  }
  return newCount;
}

async function countNewUsersByEmail(
  db: D1Database,
  universityId: string,
  emails: string[],
): Promise<number> {
  if (emails.length === 0) return 0;
  // Email lookups in `users` are stored lower-cased on insert; the
  // preview path matches that normalization so cross-provider casing
  // doesn't inflate the estimate.
  const lowered = emails.map((e) => e.toLowerCase());
  const placeholders = lowered.map(() => "?").join(", ");
  const sql = `
    SELECT lower(email) AS email
      FROM users
     WHERE university_id = ?
       AND lower(email) IN (${placeholders})
  `;
  const rows = await queryAll<{ email: string }>(db, sql, [
    universityId,
    ...lowered,
  ]);
  const known = new Set(rows.map((r) => r.email));
  let newCount = 0;
  for (const e of lowered) {
    if (!known.has(e)) newCount += 1;
  }
  return newCount;
}

async function resolveTermNameFromCache(
  connectionId: string,
  termId: string,
): Promise<string | null> {
  const cached = termsCache.get(termsCacheKey(connectionId));
  if (!cached) return null;
  const match = cached.payload.find((t) => t.external_id === termId);
  return match?.name ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/lms/sync-runs
// ---------------------------------------------------------------------------

export async function handleCreateLmsSyncRun(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const body = await readJson(ctx.request);
  const parsed = lmsSyncRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid sync-run body.",
      { issues: parsed.error.flatten() },
    );
  }
  const input = parsed.data;

  const connRow = await loadOwnedActiveConnectionOr404(
    ctx,
    actor.id,
    input.connection_id,
  );
  if (connRow instanceof Response) return connRow;

  const provider = lmsProviderRegistry.get(connRow.provider_id);
  if (!provider) {
    return errorResponse(
      503,
      "provider_unavailable",
      `LMS provider '${connRow.provider_id}' is not registered on this build.`,
    );
  }

  const termName = await resolveTermNameFromCache(connRow.id, input.term_id);

  const syncRunId = crypto.randomUUID();
  const now = new Date().toISOString();
  const initialProgress: LmsSyncRunProgress = {
    current_step: 0,
    total_steps: TOTAL_PROGRESS_STEPS,
    label: "Queued",
  };
  await execute(
    ctx.env.DB,
    `INSERT INTO lms_sync_runs
       (id, user_id, connection_id, term_id,
        started_at, completed_at, status,
        summary_json, error_log_json)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [
      syncRunId,
      actor.id,
      connRow.id,
      input.term_id,
      now,
      "pending" satisfies LmsSyncRunStatus,
      buildSummaryJson({
        summary: null,
        progress: initialProgress,
        term_name: termName,
      }),
    ],
  );

  let connection: LmsConnection;
  try {
    connection = await rowToLmsConnection(ctx, connRow);
  } catch (cause) {
    console.error("lms_sync_decrypt_failed", { cause });
    // Mark the row failed so the polling UI doesn't spin forever, then
    // surface the failure to the caller.
    await markRunFailed(ctx, syncRunId, termName, [
      {
        scope: "connection",
        message:
          cause instanceof Error
            ? cause.message
            : "Could not unwrap the LMS access token.",
      },
    ]);
    return errorResponse(
      500,
      "internal_error",
      "Could not unwrap the LMS access token. Reconnect from /app/integrations and try again.",
    );
  }

  // Schedule the runner so it survives this response. ctx.waitUntil is
  // the Cloudflare Workers contract for "keep this Promise alive after
  // the fetch handler returns". When the handler is invoked from a
  // test harness without an executionCtx, fall back to running inline
  // before responding — the test asserts on the terminal state and we
  // want the row mutated either way.
  const runnerPromise = runReconciliationForRun(ctx, provider, connection, {
    syncRunId,
    userId: actor.id,
    connectionId: connRow.id,
    termId: input.term_id,
    termName,
  });
  if (ctx.executionCtx) {
    ctx.executionCtx.waitUntil(runnerPromise);
  } else {
    await runnerPromise;
  }

  const response: CreateLmsSyncRunResponse = {
    sync_run_id: syncRunId,
    status: "pending",
  };
  return jsonOk(response, { status: 202 });
}

// ---------------------------------------------------------------------------
// GET /api/lms/sync-runs/:id
// ---------------------------------------------------------------------------

export async function handleGetLmsSyncRun(
  ctx: RequestContext,
  syncRunId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await loadSyncRunById(ctx.env.DB, syncRunId);
  if (!row || row.user_id !== actor.id) {
    // Cloak: tenant scoping uses 404 (matches the disconnect handler).
    return errorResponse(404, "not_found", "Sync run not found.");
  }
  return jsonOk<LmsSyncRunResponse>({ sync_run: syncRowToPublic(row) });
}

// ---------------------------------------------------------------------------
// GET /api/lms/sync-runs
// ---------------------------------------------------------------------------

const RUN_HISTORY_LIMIT = 20;

export async function handleListLmsSyncRuns(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const rows = await queryAll<SyncRunRow>(
    ctx.env.DB,
    `${SELECT_SYNC_RUN}
       WHERE user_id = ?
       ORDER BY started_at DESC
       LIMIT ?`,
    [actor.id, RUN_HISTORY_LIMIT],
  );
  return jsonOk<LmsSyncRunsResponse>({
    sync_runs: rows.map(syncRowToPublic),
  });
}

// ---------------------------------------------------------------------------
// Reconciliation runner (UNI-56). The route layer owns the lifecycle
// of the `lms_sync_runs` row — initial INSERT (`pending`), per-step
// progress UPDATEs (`running`), terminal UPDATE (`success` /
// `partial` / `failed`). The actual reconciliation work lives in
// `apps/worker/src/lms/reconcile.ts`; this function is the glue that
// translates engine progress callbacks into D1 writes and persists
// the engine's terminal result.
// ---------------------------------------------------------------------------

interface RunnerInput {
  syncRunId: string;
  userId: string;
  connectionId: string;
  termId: string;
  termName: string | null;
}

const TOTAL_PROGRESS_STEPS = 4;

async function runReconciliationForRun(
  ctx: RequestContext,
  provider: ReturnType<typeof lmsProviderRegistry.get>,
  connection: LmsConnection,
  input: RunnerInput,
): Promise<void> {
  if (!provider) {
    // Defensive: the route already validated the provider exists; if it
    // disappears between the validation and here, fail the run cleanly
    // instead of throwing.
    await markRunFailed(ctx, input.syncRunId, input.termName, [
      {
        scope: "connection",
        message: `LMS provider '${connection.provider_id}' is not registered on this build.`,
      },
    ]);
    return;
  }
  // Flip pending → running so the polling UI gets a transition the
  // moment work begins. Progress will keep getting bumped via the
  // engine's onProgress callback.
  try {
    await execute(
      ctx.env.DB,
      `UPDATE lms_sync_runs
          SET status = ?, summary_json = ?
        WHERE id = ?`,
      [
        "running" satisfies LmsSyncRunStatus,
        buildSummaryJson({
          summary: null,
          progress: {
            current_step: 0,
            total_steps: TOTAL_PROGRESS_STEPS,
            label: "Starting",
          },
          term_name: input.termName,
        }),
        input.syncRunId,
      ],
    );
  } catch (cause) {
    console.warn("lms_sync_running_marker_failed", {
      sync_run_id: input.syncRunId,
      cause,
    });
  }

  try {
    const result = await runLmsReconciliation(
      { db: ctx.env.DB, provider },
      {
        syncRunId: input.syncRunId,
        actorUserId: input.userId,
        connection,
        termId: input.termId,
        termName: input.termName,
        onProgress: async (progress) => {
          try {
            await execute(
              ctx.env.DB,
              `UPDATE lms_sync_runs
                  SET status = ?, summary_json = ?
                WHERE id = ?`,
              [
                "running" satisfies LmsSyncRunStatus,
                buildSummaryJson({
                  summary: null,
                  progress,
                  term_name: input.termName,
                }),
                input.syncRunId,
              ],
            );
          } catch (cause) {
            console.warn("lms_sync_progress_write_failed", {
              sync_run_id: input.syncRunId,
              cause,
            });
          }
        },
      },
    );

    const completedAt = new Date().toISOString();
    await execute(
      ctx.env.DB,
      `UPDATE lms_sync_runs
          SET status = ?, completed_at = ?, summary_json = ?, error_log_json = ?
        WHERE id = ?`,
      [
        result.status satisfies LmsSyncRunStatus,
        completedAt,
        buildSummaryJson({
          summary: result.summary,
          progress: {
            current_step: TOTAL_PROGRESS_STEPS,
            total_steps: TOTAL_PROGRESS_STEPS,
            label: "Done",
          },
          term_name: input.termName,
          conflicts: result.conflicts.length > 0 ? result.conflicts : null,
        }),
        result.errors.length > 0 ? JSON.stringify(result.errors) : null,
        input.syncRunId,
      ],
    );

    // Best-effort: bump the connection's last_synced_at so the
    // integrations page shows the right timestamp on reload. A failure
    // here doesn't downgrade the run — the row's status reflects what
    // the engine reported.
    try {
      await execute(
        ctx.env.DB,
        `UPDATE lms_connections SET last_synced_at = ?, updated_at = ?
          WHERE id = ?`,
        [completedAt, completedAt, input.connectionId],
      );
    } catch (cause) {
      console.warn("lms_sync_last_synced_update_failed", {
        connection_id: input.connectionId,
        cause,
      });
    }
  } catch (cause) {
    console.error("lms_reconcile_runner_failed", {
      sync_run_id: input.syncRunId,
      cause,
    });
    const message =
      cause instanceof Error
        ? cause.message
        : "Reconciliation runner failed before completing.";
    // 401-from-Canvas during the runner means the user's PAT was
    // revoked or rotated mid-flight. Flip the connection to `expired`
    // so the UI surfaces the "re-paste a new token" copy on next load.
    if (isCanvasUnauthorized(cause)) {
      await markConnectionExpired(ctx, input.connectionId);
    }
    await markRunFailed(ctx, input.syncRunId, input.termName, [
      { scope: "connection", message },
    ]);
    // Audit the unhandled failure so the audit page surfaces it.
    await writeAuditLog(ctx.env.DB, {
      action: "lms.sync.failed",
      actorUserId: input.userId,
      universityId: null,
      entityType: "lms_sync_run",
      entityId: input.syncRunId,
      metadata: {
        connection_id: input.connectionId,
        reason: message,
        stage: "runner",
      },
    });
  }
}

async function markRunFailed(
  ctx: RequestContext,
  syncRunId: string,
  termName: string | null,
  errors: LmsSyncError[],
): Promise<void> {
  try {
    await execute(
      ctx.env.DB,
      `UPDATE lms_sync_runs
          SET status = ?, completed_at = ?, summary_json = ?, error_log_json = ?
        WHERE id = ?`,
      [
        "failed" satisfies LmsSyncRunStatus,
        new Date().toISOString(),
        buildSummaryJson({
          summary: null,
          progress: {
            current_step: TOTAL_PROGRESS_STEPS,
            total_steps: TOTAL_PROGRESS_STEPS,
            label: "Failed",
          },
          term_name: termName,
        }),
        JSON.stringify(errors),
        syncRunId,
      ],
    );
  } catch (writeCause) {
    console.error("lms_sync_failure_write_failed", {
      sync_run_id: syncRunId,
      cause: writeCause,
    });
  }
}
