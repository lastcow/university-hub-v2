// Regression guard for UNI-66 symptom 2.
//
// 0015's `lms_sync_runs` carried `term_id TEXT REFERENCES terms(id) ON
// DELETE SET NULL`, but the route layer (UNI-55) writes the
// provider-native external term id ("245") into the column — which
// never matches any local `terms.id` UUID. Every real sync POST
// failed with SQLITE_CONSTRAINT_FOREIGNKEY. 0023 drops the FK by
// recreating the table.
//
// This test reads the migration files directly and asserts:
//   1. 0015 still defines the table the way it did (so we don't lose
//      the regression context if 0015 is ever rewritten).
//   2. 0023 recreates `lms_sync_runs` *without* the FK on `term_id`,
//      preserves the FKs on `user_id` and `connection_id`, and
//      preserves every row through a copy step.
//
// Mirrors the textual-migration assertion pattern from
// `apps/worker/test/migrations/escalation-contacts-seed.test.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const MIG_0015 = resolve(REPO_ROOT, "migrations/0015_lms.sql");
const MIG_0023 = resolve(
  REPO_ROOT,
  "migrations/0023_lms_sync_runs_drop_term_fk.sql",
);

describe("0015 baseline (regression context)", () => {
  const sql = readFileSync(MIG_0015, "utf8");

  it("originally defined term_id as a FK into terms(id)", () => {
    // We do NOT want to lose this anchor — if a future rewrite of 0015
    // drops the offending FK at the source, this assertion goes red and
    // the author will see why 0023 exists.
    expect(sql).toMatch(/term_id\s+TEXT\s+REFERENCES\s+terms\(id\)/);
  });
});

describe("0023 drops the term_id FK on lms_sync_runs", () => {
  const sql = readFileSync(MIG_0023, "utf8");

  it("recreates the table via rename + insert + drop (SQLite has no DROP CONSTRAINT)", () => {
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+lms_sync_runs\s+RENAME\s+TO\s+lms_sync_runs_old/i,
    );
    expect(sql).toMatch(/CREATE\s+TABLE\s+lms_sync_runs\b/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+lms_sync_runs/i);
    expect(sql).toMatch(/FROM\s+lms_sync_runs_old/i);
    expect(sql).toMatch(/DROP\s+TABLE\s+lms_sync_runs_old/i);
  });

  it("the new table declares term_id as a plain TEXT column with no REFERENCES clause", () => {
    // Pull the body of the CREATE TABLE statement and check that the
    // `term_id` column line does not carry a REFERENCES clause.
    const match = sql.match(/CREATE\s+TABLE\s+lms_sync_runs\s*\(([\s\S]*?)\);/i);
    expect(match).not.toBeNull();
    const body = match![1]!;
    const termLine = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^term_id\b/.test(l));
    expect(termLine).toBeDefined();
    expect(termLine!).toMatch(/^term_id\s+TEXT/i);
    expect(termLine!).not.toMatch(/REFERENCES/i);
  });

  it("preserves the FKs on user_id and connection_id (those were never the bug)", () => {
    expect(sql).toMatch(
      /user_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i,
    );
    expect(sql).toMatch(
      /connection_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+lms_connections\(id\)\s+ON\s+DELETE\s+CASCADE/i,
    );
  });

  it("recreates every index 0015 declared", () => {
    const indexes = [
      "idx_lms_sync_runs_user_id",
      "idx_lms_sync_runs_connection_id",
      "idx_lms_sync_runs_term_id",
      "idx_lms_sync_runs_status",
      "idx_lms_sync_runs_started_at",
    ];
    for (const idx of indexes) {
      expect(sql).toContain(idx);
    }
  });
});
