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
// Reconciliation/upsert is sub-issue UNI-56. For UNI-55 the runner is a
// stub that walks a `lms_sync_runs` row through `pending → running →
// success` over a few seconds, emitting per-step progress into
// `summary_json.progress` so the UI's polling view has something to
// render. The structure is intentional: when UNI-56 swaps in the real
// reconciliation engine, the runner signature stays the same and the
// route shell does not change.

import {
  type CreateLmsSyncRunResponse,
  type LmsConnectionStatus,
  type LmsConnectionTermsResponse,
  type LmsProviderId,
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
import { requireAuth, type RequestContext } from "../middleware/auth.js";
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
  auth_method: "oauth" | "pat";
  base_url: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scope: string | null;
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
  SELECT id, user_id, university_id, provider_id, auth_method, base_url,
         access_token_encrypted, refresh_token_encrypted,
         token_expires_at, scope, status, last_synced_at,
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

/** Decrypt a connection row's access token (and, when present, refresh
 *  token) and reshape into the substrate `LmsConnection` the provider
 *  methods accept. The plaintext lives only in the returned object's
 *  closure for the duration of the route handler — never logged,
 *  never returned to the SPA, never rewritten to D1. */
async function rowToLmsConnection(
  ctx: RequestContext,
  row: ConnectionRow,
): Promise<LmsConnection> {
  if (!row.access_token_encrypted) {
    throw new Error(
      "lms_connection_missing_access_token: row exists but has no encrypted access token; reconnect required.",
    );
  }
  const accessToken = await decryptForUniversity(
    ctx.env,
    row.access_token_encrypted,
    row.university_id,
  );
  const refreshToken = row.refresh_token_encrypted
    ? await decryptForUniversity(
        ctx.env,
        row.refresh_token_encrypted,
        row.university_id,
      )
    : null;
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    provider_id: row.provider_id,
    auth_method: row.auth_method,
    base_url: row.base_url,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at:
      (row.token_expires_at ?? null) as LmsConnection["token_expires_at"],
    scope: row.scope,
    status: row.status,
    last_synced_at:
      (row.last_synced_at ?? null) as LmsConnection["last_synced_at"],
    created_at: row.created_at as LmsConnection["created_at"],
    updated_at: row.updated_at as LmsConnection["updated_at"],
  };
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
    progress: parsedSummary.progress,
  };
}

interface ParsedSummary {
  summary: LmsSyncSummary | null;
  progress: LmsSyncRunProgress | null;
  term_name: string | null;
}

/** `summary_json` carries three logical fields packed into one column
 *  to keep the schema unchanged from UNI-51:
 *
 *    - `summary`    : final per-run counts (UNI-56 fills these in).
 *    - `progress`   : in-flight progress signal for UI polling.
 *    - `term_name`  : display label captured at run-start so the UI
 *                     doesn't have to re-fetch the term list to render
 *                     the run history.
 *
 *  Unknown / malformed JSON is treated as null on every field so a
 *  hand-edited row doesn't crash the route. */
function parseSummaryJson(raw: string | null): ParsedSummary {
  if (!raw) return { summary: null, progress: null, term_name: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { summary: null, progress: null, term_name: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { summary: null, progress: null, term_name: null };
  }
  const obj = parsed as Record<string, unknown>;
  const summary = obj.summary && typeof obj.summary === "object"
    ? (obj.summary as LmsSyncSummary)
    : null;
  const progress = obj.progress && typeof obj.progress === "object"
    ? normaliseProgress(obj.progress as Record<string, unknown>)
    : null;
  const term_name = typeof obj.term_name === "string" ? obj.term_name : null;
  return { summary, progress, term_name };
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
}): string {
  return JSON.stringify({
    summary: input.summary,
    progress: input.progress,
    term_name: input.term_name,
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
  const studentEmails = new Set<string>();
  const courseExternalIds: string[] = [];
  let studentsTotal = 0;
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
      studentsTotal += 1;
      if (enr.email) studentEmails.add(enr.email.toLowerCase());
    }
  }

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
    total_steps: STUB_TOTAL_STEPS,
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

  // Schedule the runner so it survives this response. ctx.waitUntil is
  // the Cloudflare Workers contract for "keep this Promise alive after
  // the fetch handler returns". When the handler is invoked from a
  // test harness without an executionCtx, fall back to running inline
  // before responding — the test asserts on the terminal state and we
  // want the row mutated either way.
  const runnerPromise = runStubSync(ctx, {
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
// Stub runner (UNI-55 Phase-1 placeholder). UNI-56 replaces with the
// real reconciliation engine.
// ---------------------------------------------------------------------------

interface RunnerInput {
  syncRunId: string;
  userId: string;
  connectionId: string;
  termId: string;
  termName: string | null;
}

const STUB_TOTAL_STEPS = 4;
/** Step delay during the placeholder run. Short enough that QA can
 *  watch it complete in a deploy preview, long enough that the polling
 *  UI sees more than one transition. UNI-56 will replace this with
 *  real per-row work and should not need to keep this constant. */
const STUB_STEP_DELAY_MS = 1500;
/** Test seam: tests pass `0` so the placeholder runs synchronously. */
let stubStepDelayOverrideMs: number | null = null;
export function __setStubStepDelayMsForTest(ms: number | null): void {
  stubStepDelayOverrideMs = ms;
}

async function runStubSync(
  ctx: RequestContext,
  input: RunnerInput,
): Promise<void> {
  const stepDelay =
    stubStepDelayOverrideMs ?? STUB_STEP_DELAY_MS;
  try {
    await stepTransition(ctx, input, "running", {
      current_step: 1,
      total_steps: STUB_TOTAL_STEPS,
      label: "Listing courses",
    });
    await sleep(stepDelay);

    await stepTransition(ctx, input, "running", {
      current_step: 2,
      total_steps: STUB_TOTAL_STEPS,
      label: "Listing enrollments",
    });
    await sleep(stepDelay);

    await stepTransition(ctx, input, "running", {
      current_step: 3,
      total_steps: STUB_TOTAL_STEPS,
      label: "Reconciliation engine pending (UNI-56)",
    });
    await sleep(stepDelay);

    // UNI-56 fills these counts in once the reconciliation engine lands.
    // The placeholder records all-zero counts so the SPA's completion
    // pane has a stable shape to render from day one.
    const finalSummary: LmsSyncSummary = {
      courses_created: 0,
      courses_updated: 0,
      courses_unchanged: 0,
      students_created: 0,
      students_matched: 0,
      students_invited: 0,
      enrollments_created: 0,
      enrollments_updated: 0,
      enrollments_unchanged: 0,
    };

    const completedAt = new Date().toISOString();
    await execute(
      ctx.env.DB,
      `UPDATE lms_sync_runs
          SET status = ?, completed_at = ?, summary_json = ?
        WHERE id = ?`,
      [
        "success" satisfies LmsSyncRunStatus,
        completedAt,
        buildSummaryJson({
          summary: finalSummary,
          progress: {
            current_step: STUB_TOTAL_STEPS,
            total_steps: STUB_TOTAL_STEPS,
            label: "Done",
          },
          term_name: input.termName,
        }),
        input.syncRunId,
      ],
    );

    // Refresh the connection's last_synced_at so the integrations page
    // shows the right timestamp on reload. Best-effort — a failure
    // here doesn't downgrade the run.
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
    console.error("lms_stub_runner_failed", {
      sync_run_id: input.syncRunId,
      cause,
    });
    const errors: LmsSyncError[] = [
      {
        scope: "connection",
        message:
          cause instanceof Error
            ? cause.message
            : "Stub runner failed before completing.",
      },
    ];
    try {
      await execute(
        ctx.env.DB,
        `UPDATE lms_sync_runs
            SET status = ?, completed_at = ?, error_log_json = ?
          WHERE id = ?`,
        [
          "failed" satisfies LmsSyncRunStatus,
          new Date().toISOString(),
          JSON.stringify(errors),
          input.syncRunId,
        ],
      );
    } catch (writeCause) {
      console.error("lms_stub_runner_failure_write_failed", {
        sync_run_id: input.syncRunId,
        cause: writeCause,
      });
    }
  }
}

async function stepTransition(
  ctx: RequestContext,
  input: RunnerInput,
  status: LmsSyncRunStatus,
  progress: LmsSyncRunProgress,
): Promise<void> {
  await execute(
    ctx.env.DB,
    `UPDATE lms_sync_runs
        SET status = ?, summary_json = ?
      WHERE id = ?`,
    [
      status,
      buildSummaryJson({
        summary: null,
        progress,
        term_name: input.termName,
      }),
      input.syncRunId,
    ],
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
