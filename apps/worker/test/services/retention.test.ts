// Tests for the UNI-33 nightly retention sweep.
//
// We exercise the service against an in-memory DB that interprets the SQL
// shapes the service actually emits (INSERT OR IGNORE ... SELECT ... FROM
// X WHERE <predicate>, DELETE FROM X WHERE <predicate>, plain
// SELECT COUNT(*) for dry-run). That keeps the test focused on the
// retention-policy invariants — backdated rows move to the archive,
// purges happen on the right tables, env overrides flow through — without
// depending on an external SQLite engine.
//
// Acceptance-criteria coverage in this file:
//   - "Test seed: insert rows backdated past their retention window; cron
//     run moves them to archive / purges them." — see the suite below.
//   - "Per-customer override via env vars works." — see "honors RETENTION_*
//     env overrides".
//   - "Idempotent." — see "second run is a no-op".

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import { runScheduledRetention } from "../../src/services/retention.js";

type Row = Record<string, unknown>;

interface MemoryTables {
  [table: string]: Row[];
}

const ARCHIVE_PARENT: Record<string, string> = {
  archived_grades: "grades",
  archived_assessments: "assessments",
  archived_course_assignments: "course_assignments",
  archived_audit_logs: "audit_logs",
  archived_email_logs: "email_logs",
  archived_grade_access_log: "grade_access_log",
};

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function parsePredicate(sql: string): {
  table: string;
  matcher: (row: Row, params: readonly unknown[]) => boolean;
} | null {
  // INSERT OR IGNORE INTO archived_X (...) SELECT ... FROM X WHERE <pred>
  const insertMatch = /INSERT OR IGNORE INTO (\w+) \(.*?\) SELECT .*? FROM (\w+) WHERE (.*)$/i.exec(sql);
  if (insertMatch) {
    return {
      table: insertMatch[2] ?? "",
      matcher: predicateMatcher(insertMatch[3] ?? ""),
    };
  }
  // DELETE FROM X WHERE <pred>
  const deleteMatch = /DELETE FROM (\w+) WHERE (.*)$/i.exec(sql);
  if (deleteMatch) {
    return {
      table: deleteMatch[1] ?? "",
      matcher: predicateMatcher(deleteMatch[2] ?? ""),
    };
  }
  // SELECT COUNT(*) AS c FROM X WHERE <pred>
  const countMatch = /SELECT COUNT\(\*\) AS c FROM (\w+) WHERE (.*)$/i.exec(sql);
  if (countMatch) {
    return {
      table: countMatch[1] ?? "",
      matcher: predicateMatcher(countMatch[2] ?? ""),
    };
  }
  return null;
}

function predicateMatcher(pred: string): (row: Row, params: readonly unknown[]) => boolean {
  const normalized = pred.trim();
  // "deleted_at IS NOT NULL AND deleted_at < ?"
  if (/^deleted_at IS NOT NULL AND deleted_at < \?$/i.test(normalized)) {
    return (row, params) => {
      const v = row.deleted_at;
      return v !== null && v !== undefined && (v as string) < (params[0] as string);
    };
  }
  // Generic "<col> < ?"
  const lessMatch = /^(\w+) < \?$/.exec(normalized);
  if (lessMatch) {
    const col = lessMatch[1] as string;
    return (row, params) => {
      const v = row[col];
      if (v === null || v === undefined) return false;
      const p = params[0];
      if (typeof v === "number" || typeof p === "number") {
        return Number(v) < Number(p);
      }
      return (v as string) < (p as string);
    };
  }
  throw new Error(`Unrecognized predicate in test harness: ${pred}`);
}

function selectColumns(sql: string): string[] {
  // Pulls the column list from `INSERT OR IGNORE INTO archive (col1, col2, ...) SELECT ...`
  const m = /INSERT OR IGNORE INTO \w+ \((.*?)\) SELECT/i.exec(sql);
  if (!m) return [];
  return (m[1] ?? "").split(",").map((c) => c.trim());
}

class MemoryD1 {
  tables: MemoryTables;

  constructor(tables: MemoryTables) {
    this.tables = tables;
  }

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql, []);
  }

  // The retention service's queryFirst<{ c: number }>() path is the only
  // SELECT we have to support. INSERTs and DELETEs are interpreted in
  // `run()`.
}

class MemoryStatement {
  constructor(
    private readonly db: MemoryD1,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: unknown[]): MemoryStatement {
    return new MemoryStatement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const sql = normalize(this.sql);
    if (/^PRAGMA/i.test(sql)) return null;
    const parsed = parsePredicate(sql);
    if (!parsed || !/SELECT COUNT/i.test(sql)) return null;
    const rows = this.db.tables[parsed.table] ?? [];
    const c = rows.filter((r) => parsed.matcher(r, this.params)).length;
    return { c } as unknown as T;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number | null } }> {
    const sql = normalize(this.sql);
    if (/^PRAGMA/i.test(sql)) {
      return { meta: { changes: 0, last_row_id: null } };
    }
    const parsed = parsePredicate(sql);
    if (!parsed) {
      throw new Error(`MemoryD1: unsupported SQL: ${sql}`);
    }
    if (/^INSERT OR IGNORE/i.test(sql)) {
      const sourceTable = parsed.table;
      const archiveMatch = /INSERT OR IGNORE INTO (\w+)/i.exec(sql);
      const archiveTable = archiveMatch?.[1] ?? "";
      const cols = selectColumns(sql);
      const sourceRows = this.db.tables[sourceTable] ?? [];
      const archiveRows = (this.db.tables[archiveTable] ??= []);
      const existingIds = new Set(archiveRows.map((r) => r.id as string));
      const due = sourceRows.filter((r) => parsed.matcher(r, this.params));
      let inserted = 0;
      for (const row of due) {
        if (existingIds.has(row.id as string)) continue;
        const copy: Row = {};
        for (const col of cols) copy[col] = row[col];
        copy.retention_archived_at = "2026-05-04T03:00:00.000Z";
        archiveRows.push(copy);
        inserted++;
      }
      return { meta: { changes: inserted, last_row_id: null } };
    }
    if (/^DELETE FROM/i.test(sql)) {
      const table = parsed.table;
      const rows = this.db.tables[table] ?? [];
      const before = rows.length;
      this.db.tables[table] = rows.filter((r) => !parsed.matcher(r, this.params));
      return {
        meta: { changes: before - this.db.tables[table]!.length, last_row_id: null },
      };
    }
    throw new Error(`MemoryD1: unsupported run() SQL: ${sql}`);
  }
}

const TS_NOW = "2026-05-04T03:00:00.000Z";
const NOW = new Date(TS_NOW);

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function makeEnv(db: MemoryD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    APP_ENV: "test",
    ...overrides,
  };
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("runScheduledRetention", () => {
  it("archives backdated educational records and skips fresh ones", async () => {
    const db = new MemoryD1({
      grades: [
        { id: "old-g1", assessment_id: "a1", student_user_id: "s1", score: 88, letter_grade: "B", feedback: null, status: "graded", graded_by_user_id: null, graded_at: null, created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
        { id: "fresh-g1", assessment_id: "a1", student_user_id: "s2", score: 92, letter_grade: "A", feedback: null, status: "graded", graded_by_user_id: null, graded_at: null, created_at: isoDaysAgo(10), updated_at: isoDaysAgo(10) },
      ],
      assessments: [
        { id: "old-a1", course_id: "c1", title: "Old", description: null, weight: 0.2, max_score: 100, due_at: null, created_by: null, deleted_at: null, created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
        { id: "fresh-a1", course_id: "c1", title: "New", description: null, weight: 0.2, max_score: 100, due_at: null, created_by: null, deleted_at: null, created_at: isoDaysAgo(2), updated_at: isoDaysAgo(2) },
      ],
      course_assignments: [
        { id: "old-ca1", course_id: "c1", user_id: "u1", role: "student", created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
      ],
      audit_logs: [],
      email_logs: [],
      grade_access_log: [],
      sessions: [],
      rate_limit_counters: [],
      mfa_challenges: [],
      parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_grades: [],
      archived_assessments: [],
      archived_course_assignments: [],
      archived_audit_logs: [],
      archived_email_logs: [],
      archived_grade_access_log: [],
    });
    const env = makeEnv(db);
    const result = await runScheduledRetention(env, NOW);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(db.tables.archived_grades).toHaveLength(1);
    expect(db.tables.archived_grades?.[0]?.id).toBe("old-g1");
    expect(db.tables.grades).toHaveLength(1);
    expect(db.tables.grades?.[0]?.id).toBe("fresh-g1");
    expect(db.tables.archived_assessments?.map((r) => r.id)).toEqual(["old-a1"]);
    expect(db.tables.assessments?.map((r) => r.id)).toEqual(["fresh-a1"]);
    expect(db.tables.archived_course_assignments).toHaveLength(1);
    expect(db.tables.course_assignments).toHaveLength(0);
  });

  it("archives soft-deleted assessments at the 1y window even when their updated_at is fresh", async () => {
    const db = new MemoryD1({
      grades: [],
      assessments: [
        // Soft-deleted 18 months ago; updated_at is also old, but the
        // soft-deleted step should still credit the move because it runs
        // first and the educational sweep no-ops on an already-archived row.
        { id: "soft-old", course_id: "c1", title: "X", description: null, weight: 0, max_score: 100, due_at: null, created_by: null, deleted_at: isoDaysAgo(540), created_at: isoDaysAgo(540), updated_at: isoDaysAgo(540) },
        // Soft-deleted only 6 months ago — within the 1y window, do not
        // archive yet (and updated_at is fresh too).
        { id: "soft-fresh", course_id: "c1", title: "Y", description: null, weight: 0, max_score: 100, due_at: null, created_by: null, deleted_at: isoDaysAgo(180), created_at: isoDaysAgo(180), updated_at: isoDaysAgo(180) },
      ],
      course_assignments: [],
      audit_logs: [],
      email_logs: [],
      grade_access_log: [],
      sessions: [],
      rate_limit_counters: [],
      mfa_challenges: [],
      parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_assessments: [],
      archived_grades: [],
      archived_course_assignments: [],
      archived_audit_logs: [],
      archived_email_logs: [],
      archived_grade_access_log: [],
    });
    const result = await runScheduledRetention(makeEnv(db), NOW);
    expect(result.ok).toBe(true);
    const softStep = result.steps.find((s) => s.name === "soft_deleted_assessments");
    expect(softStep?.archived).toBe(1);
    expect(db.tables.archived_assessments?.map((r) => r.id)).toEqual(["soft-old"]);
    expect(db.tables.assessments?.map((r) => r.id)).toEqual(["soft-fresh"]);
  });

  it("archives audit_logs / grade_access_log / email_logs at the right windows", async () => {
    const db = new MemoryD1({
      grades: [],
      assessments: [],
      course_assignments: [],
      audit_logs: [
        { id: "a-old", university_id: null, actor_user_id: null, action: "auth.sign_in", entity_type: null, entity_id: null, metadata_json: null, created_at: isoDaysAgo(2600) },
        { id: "a-fresh", university_id: null, actor_user_id: null, action: "auth.sign_in", entity_type: null, entity_id: null, metadata_json: null, created_at: isoDaysAgo(30) },
      ],
      email_logs: [
        { id: "e-old", university_id: null, recipient_email: "x@example.com", type: "invitation", template_name: null, status: "sent", mailgun_message_id: null, error: null, related_entity_type: null, related_entity_id: null, created_at: isoDaysAgo(120) },
        { id: "e-fresh", university_id: null, recipient_email: "y@example.com", type: "invitation", template_name: null, status: "sent", mailgun_message_id: null, error: null, related_entity_type: null, related_entity_id: null, created_at: isoDaysAgo(30) },
      ],
      grade_access_log: [
        { id: "gal-old", viewer_user_id: null, viewer_role: "faculty", viewer_course_role: "faculty", course_id: null, assessment_id: null, viewed_grade_id: null, viewed_student_user_id: null, context: "view_grade", accessed_at: isoDaysAgo(2600) },
        { id: "gal-fresh", viewer_user_id: null, viewer_role: "faculty", viewer_course_role: "faculty", course_id: null, assessment_id: null, viewed_grade_id: null, viewed_student_user_id: null, context: "view_grade", accessed_at: isoDaysAgo(30) },
      ],
      sessions: [],
      rate_limit_counters: [],
      mfa_challenges: [],
      parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_audit_logs: [],
      archived_email_logs: [],
      archived_grade_access_log: [],
      archived_grades: [],
      archived_assessments: [],
      archived_course_assignments: [],
    });
    const result = await runScheduledRetention(makeEnv(db), NOW);
    expect(result.ok).toBe(true);
    expect(db.tables.archived_audit_logs?.map((r) => r.id)).toEqual(["a-old"]);
    expect(db.tables.audit_logs?.map((r) => r.id)).toEqual(["a-fresh"]);
    expect(db.tables.archived_email_logs?.map((r) => r.id)).toEqual(["e-old"]);
    expect(db.tables.email_logs?.map((r) => r.id)).toEqual(["e-fresh"]);
    expect(db.tables.archived_grade_access_log?.map((r) => r.id)).toEqual([
      "gal-old",
    ]);
    expect(db.tables.grade_access_log?.map((r) => r.id)).toEqual(["gal-fresh"]);
  });

  it("purges sessions / rate_limit_counters / mfa_challenges past their windows", async () => {
    const db = new MemoryD1({
      grades: [],
      assessments: [],
      course_assignments: [],
      audit_logs: [],
      email_logs: [],
      grade_access_log: [],
      sessions: [
        { id: "sess-old", expires_at: isoDaysAgo(31) },
        { id: "sess-fresh", expires_at: isoDaysAgo(15) },
      ],
      rate_limit_counters: [
        // expires_at is INTEGER ms.
        { key: "rl-old", count: 0, window_started_at: 0, expires_at: NOW.getTime() - 31 * 86_400_000 },
        { key: "rl-fresh", count: 0, window_started_at: 0, expires_at: NOW.getTime() - 15 * 86_400_000 },
      ],
      mfa_challenges: [
        { id: "mfa-old", expires_at: isoDaysAgo(31) },
        { id: "mfa-fresh", expires_at: isoDaysAgo(15) },
      ],
      parent_sign_in_tokens: [
        { id: "pt-old", expires_at: isoDaysAgo(31) },
        { id: "pt-fresh", expires_at: isoDaysAgo(15) },
      ],
      parent_sessions: [
        { id: "ps-old", expires_at: isoDaysAgo(31) },
        { id: "ps-fresh", expires_at: isoDaysAgo(15) },
      ],
      archived_audit_logs: [],
      archived_email_logs: [],
      archived_grade_access_log: [],
      archived_grades: [],
      archived_assessments: [],
      archived_course_assignments: [],
    });
    const result = await runScheduledRetention(makeEnv(db), NOW);
    expect(result.ok).toBe(true);
    expect(db.tables.sessions?.map((r) => r.id)).toEqual(["sess-fresh"]);
    expect(db.tables.rate_limit_counters?.map((r) => r.key)).toEqual(["rl-fresh"]);
    expect(db.tables.mfa_challenges?.map((r) => r.id)).toEqual(["mfa-fresh"]);
    expect(db.tables.parent_sign_in_tokens?.map((r) => r.id)).toEqual(["pt-fresh"]);
    expect(db.tables.parent_sessions?.map((r) => r.id)).toEqual(["ps-fresh"]);
  });

  it("purges archive shadow tables once their ultimate retention expires (email default 1y)", async () => {
    const db = new MemoryD1({
      grades: [],
      assessments: [],
      course_assignments: [],
      audit_logs: [],
      email_logs: [],
      grade_access_log: [],
      sessions: [],
      rate_limit_counters: [],
      mfa_challenges: [],
      parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_email_logs: [
        { id: "ae-old", retention_archived_at: isoDaysAgo(400), created_at: isoDaysAgo(490) },
        { id: "ae-fresh", retention_archived_at: isoDaysAgo(180), created_at: isoDaysAgo(270) },
      ],
      archived_audit_logs: [
        // No env var set → step is skipped, both rows survive.
        { id: "aa-old", retention_archived_at: isoDaysAgo(4000), created_at: isoDaysAgo(4000) },
      ],
      archived_grade_access_log: [],
      archived_grades: [],
      archived_assessments: [],
      archived_course_assignments: [],
    });
    const result = await runScheduledRetention(makeEnv(db), NOW);
    expect(result.ok).toBe(true);
    expect(db.tables.archived_email_logs?.map((r) => r.id)).toEqual(["ae-fresh"]);
    expect(db.tables.archived_audit_logs?.map((r) => r.id)).toEqual(["aa-old"]);
    const auditArchiveStep = result.steps.find(
      (s) => s.name === "archive_audit_logs",
    );
    expect(auditArchiveStep?.config.skipped).toBe(true);
  });

  it("opts into archive_audit_logs purge when RETENTION_ARCHIVE_AUDIT_LOG_DAYS is set", async () => {
    const db = new MemoryD1({
      grades: [], assessments: [], course_assignments: [], audit_logs: [],
      email_logs: [], grade_access_log: [], sessions: [], rate_limit_counters: [],
      mfa_challenges: [], parent_sign_in_tokens: [], parent_sessions: [],
      archived_audit_logs: [
        { id: "aa-very-old", retention_archived_at: isoDaysAgo(2600), created_at: isoDaysAgo(2600) },
        { id: "aa-medium", retention_archived_at: isoDaysAgo(1500), created_at: isoDaysAgo(1500) },
      ],
      archived_email_logs: [], archived_grade_access_log: [],
      archived_grades: [], archived_assessments: [], archived_course_assignments: [],
    });
    const env = makeEnv(db, { RETENTION_ARCHIVE_AUDIT_LOG_DAYS: "2000" });
    const result = await runScheduledRetention(env, NOW);
    expect(result.ok).toBe(true);
    expect(db.tables.archived_audit_logs?.map((r) => r.id)).toEqual(["aa-medium"]);
  });

  it("honors RETENTION_EMAIL_LOG_DAYS env override", async () => {
    const db = new MemoryD1({
      grades: [], assessments: [], course_assignments: [], audit_logs: [],
      grade_access_log: [], sessions: [], rate_limit_counters: [],
      mfa_challenges: [], parent_sign_in_tokens: [], parent_sessions: [],
      email_logs: [
        { id: "e-30", university_id: null, recipient_email: "x@example.com", type: "invitation", template_name: null, status: "sent", mailgun_message_id: null, error: null, related_entity_type: null, related_entity_id: null, created_at: isoDaysAgo(31) },
        { id: "e-90", university_id: null, recipient_email: "x@example.com", type: "invitation", template_name: null, status: "sent", mailgun_message_id: null, error: null, related_entity_type: null, related_entity_id: null, created_at: isoDaysAgo(91) },
      ],
      archived_audit_logs: [], archived_email_logs: [], archived_grade_access_log: [],
      archived_grades: [], archived_assessments: [], archived_course_assignments: [],
    });
    // Override to 30 → both rows are due.
    const env = makeEnv(db, { RETENTION_EMAIL_LOG_DAYS: "30" });
    const result = await runScheduledRetention(env, NOW);
    expect(result.ok).toBe(true);
    expect(db.tables.email_logs).toHaveLength(0);
    expect(db.tables.archived_email_logs?.map((r) => r.id).sort()).toEqual([
      "e-30",
      "e-90",
    ]);
    const step = result.steps.find((s) => s.name === "email_logs");
    expect(step?.config.days).toBe(30);
  });

  it("RETENTION_DRY_RUN reports the would-archive / would-purge counts without mutating", async () => {
    const db = new MemoryD1({
      grades: [
        { id: "old-g1", assessment_id: "a1", student_user_id: "s1", score: 1, letter_grade: null, feedback: null, status: "graded", graded_by_user_id: null, graded_at: null, created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
      ],
      assessments: [], course_assignments: [], audit_logs: [], email_logs: [],
      grade_access_log: [],
      sessions: [{ id: "old", expires_at: isoDaysAgo(31) }],
      rate_limit_counters: [], mfa_challenges: [], parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_grades: [], archived_assessments: [], archived_course_assignments: [],
      archived_audit_logs: [], archived_email_logs: [], archived_grade_access_log: [],
    });
    const env = makeEnv(db, { RETENTION_DRY_RUN: "1" });
    const result = await runScheduledRetention(env, NOW);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(db.tables.grades).toHaveLength(1);
    expect(db.tables.archived_grades).toHaveLength(0);
    expect(db.tables.sessions).toHaveLength(1);
    const grades = result.steps.find((s) => s.name === "educational_grades");
    expect(grades?.archived).toBe(1);
    expect(grades?.purged).toBe(0);
    const sessions = result.steps.find((s) => s.name === "sessions");
    expect(sessions?.purged).toBe(1);
  });

  it("second run is a no-op (idempotent)", async () => {
    const db = new MemoryD1({
      grades: [
        { id: "g1", assessment_id: "a1", student_user_id: "s1", score: 1, letter_grade: null, feedback: null, status: "graded", graded_by_user_id: null, graded_at: null, created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
      ],
      assessments: [], course_assignments: [], audit_logs: [], email_logs: [],
      grade_access_log: [], sessions: [], rate_limit_counters: [],
      mfa_challenges: [], parent_sign_in_tokens: [], parent_sessions: [],
      archived_grades: [], archived_assessments: [], archived_course_assignments: [],
      archived_audit_logs: [], archived_email_logs: [], archived_grade_access_log: [],
    });
    const env = makeEnv(db);
    const first = await runScheduledRetention(env, NOW);
    expect(first.ok).toBe(true);
    const grades1 = first.steps.find((s) => s.name === "educational_grades");
    expect(grades1?.archived).toBe(1);
    expect(grades1?.purged).toBe(1);

    const second = await runScheduledRetention(env, NOW);
    expect(second.ok).toBe(true);
    const grades2 = second.steps.find((s) => s.name === "educational_grades");
    expect(grades2?.archived).toBe(0);
    expect(grades2?.purged).toBe(0);
    expect(db.tables.archived_grades).toHaveLength(1);
    expect(db.tables.grades).toHaveLength(0);
  });

  it("captures step-level errors without aborting the rest of the sweep", async () => {
    // Drop one of the tables to simulate a missing-table error from D1.
    const db = new MemoryD1({
      grades: [
        { id: "g1", assessment_id: "a1", student_user_id: "s1", score: 1, letter_grade: null, feedback: null, status: "graded", graded_by_user_id: null, graded_at: null, created_at: isoDaysAgo(2600), updated_at: isoDaysAgo(2600) },
      ],
      assessments: [], course_assignments: [], audit_logs: [], email_logs: [],
      grade_access_log: [],
      sessions: [{ id: "old", expires_at: isoDaysAgo(31) }],
      rate_limit_counters: [], mfa_challenges: [], parent_sign_in_tokens: [],
      parent_sessions: [],
      archived_assessments: [], archived_course_assignments: [],
      archived_audit_logs: [], archived_email_logs: [], archived_grade_access_log: [],
      // archived_grades intentionally omitted.
    });
    // Patch prepare so any reference to archived_grades throws.
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/archived_grades/i.test(sql)) {
        throw new Error("no such table: archived_grades");
      }
      return originalPrepare(sql);
    };
    const result = await runScheduledRetention(makeEnv(db), NOW);
    expect(result.ok).toBe(false);
    const failed = result.steps.find((s) => s.name === "educational_grades");
    expect(failed?.error).toMatch(/archived_grades/);
    // The next step still ran.
    const sessions = result.steps.find((s) => s.name === "sessions");
    expect(sessions?.purged).toBe(1);
  });
});
