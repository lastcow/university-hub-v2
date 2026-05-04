// Nightly retention sweep (UNI-33). Invoked by the Cloudflare Cron Trigger
// declared in `wrangler.toml` (separate cron from the in-Worker D1 backup
// added in UNI-27 — `wrangler.toml` dispatches by cron expression in
// `index.ts`'s `scheduled` handler).
//
// Each sweep is broken into independent **steps**. A step either:
//   - **archives** rows: copies them to a shadow `archived_<table>` and
//     then deletes them from the live table, OR
//   - **purges** rows: deletes them outright (sessions, rate-limit
//     counters, mfa challenges, parent tokens — these are ephemeral, no
//     archive needed), OR
//   - **archive-purges** rows in an `archived_<table>` whose
//     `retention_archived_at` is older than that table's ultimate-retention
//     window (e.g. `archived_email_logs` purges after a year).
//
// Steps are independent: a failure in one step is captured in the result
// and logged, but does not stop the rest of the sweep. The whole sweep is
// idempotent — every step has a deterministic SQL cutoff so re-running on
// the same `now` does no further work, and the archive paths use
// `INSERT OR IGNORE` so a partial archive→delete failure on the previous
// run cleans up automatically on the next.
//
// Test seed pattern (acceptance criteria): callers can backdate rows past
// their retention window and observe the move/purge in `result.steps[*]`.
//
// **Bounded per-run cost**: each step issues at most two DML statements
// (an `INSERT OR IGNORE ... SELECT` and a `DELETE`). For pre-launch
// volumes this is fine; once a customer accumulates millions of rows in
// any one table, switch to a paged loop. We surface the row count of
// every step so the operator can spot a step that is consistently moving
// large batches and split it before it becomes a cron-runtime problem.

import { execute, queryFirst } from "../db/index.js";
import type { Env } from "../env.js";

const DAY_MS = 86_400_000;

// Defaults are duplicated here in code (rather than read from a config
// file) so a customer who hasn't set any RETENTION_* env vars gets the
// FERPA-aligned baseline documented in docs/data-retention.md.
const DEFAULTS = {
  educational_days: 2555,        // ~7 years
  audit_log_days: 2555,
  grade_access_log_days: 2555,
  email_log_days: 90,
  soft_deleted_days: 365,
  session_purge_days: 30,
  rate_limit_purge_days: 30,
  mfa_challenge_purge_days: 30,
  parent_token_purge_days: 30,
  parent_session_purge_days: 30,
  archive_email_days: 365,
} as const;

export interface RetentionStepResult {
  /** Stable name; matches the keys in docs/data-retention.md. */
  name: string;
  /** Source live table. */
  source_table: string;
  /** Archive table; null when the step purges directly. */
  archive_table: string | null;
  /** Cutoff timestamp (ISO-8601) used in this step's WHERE clause. */
  cutoff: string;
  /** Rows copied into the archive table in this run. */
  archived?: number;
  /** Rows deleted from the source table in this run. */
  purged?: number;
  /** Always present; reflects the inspected configuration for this step. */
  config: {
    /** Days threshold (negative means "skipped"). */
    days: number | null;
    /** Whether the step was skipped because retention is disabled. */
    skipped: boolean;
    /** Reason for the skip when `skipped` is true. */
    skip_reason?: string;
  };
  /** Set on failure; leaves the rest of the sweep running. */
  error?: string;
}

export interface RetentionResult {
  ok: boolean;
  /** Wall-clock duration of the whole sweep. */
  duration_ms: number;
  /** When `RETENTION_DRY_RUN` was active for this run. */
  dry_run: boolean;
  /** Frozen `now` used for every cutoff in this sweep. */
  now: string;
  steps: RetentionStepResult[];
}

function intDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function optionalIntDays(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isDryRun(env: Env): boolean {
  return env.RETENTION_DRY_RUN === "1" || env.RETENTION_DRY_RUN === "true";
}

function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

interface CountRow extends Record<string, unknown> {
  c: number | null;
}

async function countWhere(
  db: D1Database,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const row = await queryFirst<CountRow>(db, sql, params);
  return Number(row?.c ?? 0);
}

interface ArchiveStepInput {
  /** Stable name for telemetry / docs. */
  name: string;
  source: string;
  archive: string;
  /** Column list shared by source + archive (without `retention_archived_at`). */
  columns: readonly string[];
  /** SQL fragment placed after `WHERE` (and AFTER any explicit WHERE in source). */
  whereSql: string;
  /** Params bound positionally to `whereSql`. */
  whereParams: readonly unknown[];
  /** Days configuration for this step (for the result envelope). */
  days: number;
  cutoff: string;
}

async function runArchiveStep(
  db: D1Database,
  dryRun: boolean,
  input: ArchiveStepInput,
): Promise<RetentionStepResult> {
  const { name, source, archive, columns, whereSql, whereParams, days, cutoff } = input;
  const colList = columns.join(", ");
  const result: RetentionStepResult = {
    name,
    source_table: source,
    archive_table: archive,
    cutoff,
    archived: 0,
    purged: 0,
    config: { days, skipped: false },
  };
  try {
    if (dryRun) {
      const due = await countWhere(
        db,
        `SELECT COUNT(*) AS c FROM ${source} WHERE ${whereSql}`,
        whereParams,
      );
      result.archived = due;
      result.purged = 0;
      return result;
    }
    const insertSql =
      `INSERT OR IGNORE INTO ${archive} (${colList}) ` +
      `SELECT ${colList} FROM ${source} WHERE ${whereSql}`;
    const inserted = await execute(db, insertSql, whereParams);
    result.archived = inserted.changes;
    const deleted = await execute(
      db,
      `DELETE FROM ${source} WHERE ${whereSql}`,
      whereParams,
    );
    result.purged = deleted.changes;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

interface PurgeStepInput {
  name: string;
  source: string;
  whereSql: string;
  whereParams: readonly unknown[];
  /** Days configuration for the result envelope (or `null` if N/A). */
  days: number | null;
  cutoff: string;
}

async function runPurgeStep(
  db: D1Database,
  dryRun: boolean,
  input: PurgeStepInput,
): Promise<RetentionStepResult> {
  const { name, source, whereSql, whereParams, days, cutoff } = input;
  const result: RetentionStepResult = {
    name,
    source_table: source,
    archive_table: null,
    cutoff,
    purged: 0,
    config: { days, skipped: false },
  };
  try {
    if (dryRun) {
      const due = await countWhere(
        db,
        `SELECT COUNT(*) AS c FROM ${source} WHERE ${whereSql}`,
        whereParams,
      );
      result.purged = due;
      return result;
    }
    const deleted = await execute(
      db,
      `DELETE FROM ${source} WHERE ${whereSql}`,
      whereParams,
    );
    result.purged = deleted.changes;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

function skippedStep(
  name: string,
  source: string,
  archive: string | null,
  reason: string,
): RetentionStepResult {
  return {
    name,
    source_table: source,
    archive_table: archive,
    cutoff: "",
    config: { days: null, skipped: true, skip_reason: reason },
  };
}

// Column lists for the archive INSERT...SELECT statements. Kept here as
// arrays — not derived dynamically — so any drift between the source
// schema and the archive schema is caught on review rather than at
// runtime, and so a missing column doesn't silently lose data.
const AUDIT_LOGS_COLS = [
  "id",
  "university_id",
  "actor_user_id",
  "action",
  "entity_type",
  "entity_id",
  "metadata_json",
  "created_at",
] as const;

const EMAIL_LOGS_COLS = [
  "id",
  "university_id",
  "recipient_email",
  "type",
  "template_name",
  "status",
  "mailgun_message_id",
  "error",
  "related_entity_type",
  "related_entity_id",
  "created_at",
] as const;

const GRADES_COLS = [
  "id",
  "assessment_id",
  "student_user_id",
  "score",
  "letter_grade",
  "feedback",
  "status",
  "graded_by_user_id",
  "graded_at",
  "created_at",
  "updated_at",
] as const;

const ASSESSMENTS_COLS = [
  "id",
  "course_id",
  "title",
  "description",
  "weight",
  "max_score",
  "due_at",
  "created_by",
  "deleted_at",
  "created_at",
  "updated_at",
] as const;

const COURSE_ASSIGNMENTS_COLS = [
  "id",
  "course_id",
  "user_id",
  "role",
  "created_at",
  "updated_at",
] as const;

const GRADE_ACCESS_LOG_COLS = [
  "id",
  "viewer_user_id",
  "viewer_role",
  "viewer_course_role",
  "course_id",
  "assessment_id",
  "viewed_grade_id",
  "viewed_student_user_id",
  "context",
  "accessed_at",
] as const;

export async function runScheduledRetention(
  env: Env,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const startedAt = Date.now();
  const dryRun = isDryRun(env);
  const db = env.DB;
  const steps: RetentionStepResult[] = [];

  // ---------------------------------------------------------------------
  // Educational records — grades, assessments, course_assignments → 7y by
  // `updated_at`. (We don't track graduation per se; the row's most-recent
  // mutation is the closest proxy and matches the FERPA institutional
  // norm of archiving once the record is no longer being maintained.)
  // ---------------------------------------------------------------------
  const eduDays = intDays(env.RETENTION_EDUCATIONAL_DAYS, DEFAULTS.educational_days);
  const eduCutoff = cutoffIso(now, eduDays);

  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "educational_grades",
      source: "grades",
      archive: "archived_grades",
      columns: GRADES_COLS,
      whereSql: "updated_at < ?",
      whereParams: [eduCutoff],
      days: eduDays,
      cutoff: eduCutoff,
    }),
  );
  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "educational_assessments",
      source: "assessments",
      archive: "archived_assessments",
      columns: ASSESSMENTS_COLS,
      whereSql: "updated_at < ?",
      whereParams: [eduCutoff],
      days: eduDays,
      cutoff: eduCutoff,
    }),
  );
  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "educational_course_assignments",
      source: "course_assignments",
      archive: "archived_course_assignments",
      columns: COURSE_ASSIGNMENTS_COLS,
      whereSql: "updated_at < ?",
      whereParams: [eduCutoff],
      days: eduDays,
      cutoff: eduCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Soft-deleted assessments — earlier 1y window. A soft-deleted row is
  // already a tombstone in the live table; promoting it to the archive
  // sooner keeps the live `assessments` table from accumulating tombstones.
  // The 7y educational sweep above will catch any soft-deleted rows that
  // somehow survive (defense in depth — `updated_at < eduCutoff` matches
  // both deleted and live).
  // ---------------------------------------------------------------------
  const softDays = intDays(env.RETENTION_SOFT_DELETED_DAYS, DEFAULTS.soft_deleted_days);
  const softCutoff = cutoffIso(now, softDays);

  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "soft_deleted_assessments",
      source: "assessments",
      archive: "archived_assessments",
      columns: ASSESSMENTS_COLS,
      whereSql: "deleted_at IS NOT NULL AND deleted_at < ?",
      whereParams: [softCutoff],
      days: softDays,
      cutoff: softCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Audit logs — 7y → archived_audit_logs.
  // ---------------------------------------------------------------------
  const auditDays = intDays(env.RETENTION_AUDIT_LOG_DAYS, DEFAULTS.audit_log_days);
  const auditCutoff = cutoffIso(now, auditDays);
  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "audit_logs",
      source: "audit_logs",
      archive: "archived_audit_logs",
      columns: AUDIT_LOGS_COLS,
      whereSql: "created_at < ?",
      whereParams: [auditCutoff],
      days: auditDays,
      cutoff: auditCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Grade-access log (FERPA §99.32 record-of-disclosure) — 7y → archive.
  // ---------------------------------------------------------------------
  const galDays = intDays(
    env.RETENTION_GRADE_ACCESS_LOG_DAYS,
    DEFAULTS.grade_access_log_days,
  );
  const galCutoff = cutoffIso(now, galDays);
  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "grade_access_log",
      source: "grade_access_log",
      archive: "archived_grade_access_log",
      columns: GRADE_ACCESS_LOG_COLS,
      whereSql: "accessed_at < ?",
      whereParams: [galCutoff],
      days: galDays,
      cutoff: galCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Email logs — 90d → archived_email_logs.
  // ---------------------------------------------------------------------
  const emailDays = intDays(env.RETENTION_EMAIL_LOG_DAYS, DEFAULTS.email_log_days);
  const emailCutoff = cutoffIso(now, emailDays);
  steps.push(
    await runArchiveStep(db, dryRun, {
      name: "email_logs",
      source: "email_logs",
      archive: "archived_email_logs",
      columns: EMAIL_LOGS_COLS,
      whereSql: "created_at < ?",
      whereParams: [emailCutoff],
      days: emailDays,
      cutoff: emailCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Sessions — purge (no archive). Spec: `expires_at < now - 30 days`.
  // ---------------------------------------------------------------------
  const sessionDays = intDays(
    env.RETENTION_SESSION_PURGE_DAYS,
    DEFAULTS.session_purge_days,
  );
  const sessionCutoff = cutoffIso(now, sessionDays);
  steps.push(
    await runPurgeStep(db, dryRun, {
      name: "sessions",
      source: "sessions",
      whereSql: "expires_at < ?",
      whereParams: [sessionCutoff],
      days: sessionDays,
      cutoff: sessionCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Rate-limit counters — purge. `expires_at` is INTEGER (ms since epoch),
  // not an ISO string, so we use a numeric cutoff and no ISO conversion.
  // ---------------------------------------------------------------------
  const rateDays = intDays(
    env.RETENTION_RATE_LIMIT_PURGE_DAYS,
    DEFAULTS.rate_limit_purge_days,
  );
  const rateCutoffMs = now.getTime() - rateDays * DAY_MS;
  steps.push(
    await runPurgeStep(db, dryRun, {
      name: "rate_limit_counters",
      source: "rate_limit_counters",
      whereSql: "expires_at < ?",
      whereParams: [rateCutoffMs],
      days: rateDays,
      // Surface the threshold as ISO too so the result is human-readable.
      cutoff: new Date(rateCutoffMs).toISOString(),
    }),
  );

  // ---------------------------------------------------------------------
  // MFA challenges — short-lived; purge anything past expires_at + 30d.
  // ---------------------------------------------------------------------
  const mfaDays = intDays(
    env.RETENTION_MFA_CHALLENGE_PURGE_DAYS,
    DEFAULTS.mfa_challenge_purge_days,
  );
  const mfaCutoff = cutoffIso(now, mfaDays);
  steps.push(
    await runPurgeStep(db, dryRun, {
      name: "mfa_challenges",
      source: "mfa_challenges",
      whereSql: "expires_at < ?",
      whereParams: [mfaCutoff],
      days: mfaDays,
      cutoff: mfaCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Parent sign-in tokens (UNI-32) — short-lived (15 min); purge stragglers.
  // ---------------------------------------------------------------------
  const parentTokenDays = intDays(
    env.RETENTION_PARENT_TOKEN_PURGE_DAYS,
    DEFAULTS.parent_token_purge_days,
  );
  const parentTokenCutoff = cutoffIso(now, parentTokenDays);
  steps.push(
    await runPurgeStep(db, dryRun, {
      name: "parent_sign_in_tokens",
      source: "parent_sign_in_tokens",
      whereSql: "expires_at < ?",
      whereParams: [parentTokenCutoff],
      days: parentTokenDays,
      cutoff: parentTokenCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Parent sessions (UNI-32) — purge expired; analogous to `sessions`.
  // ---------------------------------------------------------------------
  const parentSessionDays = intDays(
    env.RETENTION_PARENT_SESSION_PURGE_DAYS,
    DEFAULTS.parent_session_purge_days,
  );
  const parentSessionCutoff = cutoffIso(now, parentSessionDays);
  steps.push(
    await runPurgeStep(db, dryRun, {
      name: "parent_sessions",
      source: "parent_sessions",
      whereSql: "expires_at < ?",
      whereParams: [parentSessionCutoff],
      days: parentSessionDays,
      cutoff: parentSessionCutoff,
    }),
  );

  // ---------------------------------------------------------------------
  // Archive ultimate-retention sweeps. Email is the documented case
  // ("archived emails purged after a year"); the rest default to
  // "skip" — operators can opt in per customer with the corresponding
  // `RETENTION_ARCHIVE_*_DAYS` env var.
  // ---------------------------------------------------------------------
  const archiveSweeps: Array<{
    name: string;
    table: string;
    days: number | null;
  }> = [
    {
      name: "archive_email_logs",
      table: "archived_email_logs",
      days: intDays(env.RETENTION_ARCHIVE_EMAIL_DAYS, DEFAULTS.archive_email_days),
    },
    {
      name: "archive_audit_logs",
      table: "archived_audit_logs",
      days: optionalIntDays(env.RETENTION_ARCHIVE_AUDIT_LOG_DAYS),
    },
    {
      name: "archive_grade_access_log",
      table: "archived_grade_access_log",
      days: optionalIntDays(env.RETENTION_ARCHIVE_GRADE_ACCESS_LOG_DAYS),
    },
    {
      name: "archive_grades",
      table: "archived_grades",
      days: optionalIntDays(env.RETENTION_ARCHIVE_GRADES_DAYS),
    },
    {
      name: "archive_assessments",
      table: "archived_assessments",
      days: optionalIntDays(env.RETENTION_ARCHIVE_ASSESSMENTS_DAYS),
    },
    {
      name: "archive_course_assignments",
      table: "archived_course_assignments",
      days: optionalIntDays(env.RETENTION_ARCHIVE_COURSE_ASSIGNMENTS_DAYS),
    },
  ];

  for (const sweep of archiveSweeps) {
    if (sweep.days === null) {
      steps.push(
        skippedStep(
          sweep.name,
          sweep.table,
          null,
          "no RETENTION_ARCHIVE_*_DAYS configured; archive retained indefinitely",
        ),
      );
      continue;
    }
    const cutoff = cutoffIso(now, sweep.days);
    steps.push(
      await runPurgeStep(db, dryRun, {
        name: sweep.name,
        source: sweep.table,
        whereSql: "retention_archived_at < ?",
        whereParams: [cutoff],
        days: sweep.days,
        cutoff,
      }),
    );
  }

  return {
    ok: steps.every((s) => !s.error),
    duration_ms: Date.now() - startedAt,
    dry_run: dryRun,
    now: now.toISOString(),
    steps,
  };
}
