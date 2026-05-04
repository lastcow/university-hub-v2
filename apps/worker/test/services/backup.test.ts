// Tests for the UNI-27 in-Worker D1 → R2 backup service.
//
// The service is invoked by the Cloudflare Cron Trigger declared in
// `wrangler.toml`. We exercise it with a fake R2 bucket + a stub D1 (just
// the `dump()` method) so the assertions cover:
//   - missing R2 binding → `ok: false` with a structured reason.
//   - `D1.dump()` rejection → `ok: false` with the failure surfaced.
//   - tier selection by date (daily / weekly on Sundays / monthly on the 1st).
//   - retention sweep deleting only the objects past the configured ceiling.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import { runScheduledBackup } from "../../src/services/backup.js";

interface FakeObject {
  key: string;
  body: ArrayBuffer;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

class FakeR2Bucket {
  // A tiny in-memory R2 stand-in. Supports the `put`, `delete`, and `list`
  // surface the backup service actually calls. List ordering is the same
  // alphabetical order the real R2 returns; the service does its own sort
  // by `uploaded` desc before applying retention.
  store = new Map<string, FakeObject>();
  putCalls: Array<{ key: string; size: number; metadata?: Record<string, string> }> = [];
  deleteCalls: string[] = [];

  async put(key: string, body: ArrayBuffer, opts?: { customMetadata?: Record<string, string> }) {
    const obj: FakeObject = {
      key,
      body,
      uploaded: new Date(),
      customMetadata: opts?.customMetadata,
    };
    this.store.set(key, obj);
    this.putCalls.push({ key, size: body.byteLength, metadata: opts?.customMetadata });
    return obj;
  }

  async delete(key: string) {
    this.store.delete(key);
    this.deleteCalls.push(key);
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = opts.prefix ?? "";
    const all = [...this.store.values()]
      .filter((o) => o.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { objects: all, truncated: false, cursor: undefined };
  }

  // Seed helper used by retention tests — set deterministic uploaded dates.
  seed(key: string, uploaded: Date, body = new ArrayBuffer(8)) {
    this.store.set(key, { key, body, uploaded });
  }
}

class StubD1 {
  constructor(private readonly result: ArrayBuffer | Error) {}
  async dump(): Promise<ArrayBuffer> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  // Unused surface — present to satisfy the D1Database type cast.
  prepare() {
    throw new Error("not used");
  }
  batch() {
    throw new Error("not used");
  }
  exec() {
    throw new Error("not used");
  }
}

function makeEnv(overrides: Partial<{ db: StubD1; bucket: FakeR2Bucket } & Env> = {}): Env {
  const db = overrides.db ?? new StubD1(new ArrayBuffer(64));
  const bucket = overrides.bucket;
  return {
    DB: db as unknown as D1Database,
    BACKUPS: bucket as unknown as R2Bucket,
    APP_ENV: "test",
  };
}

beforeAll(() => {
  // Pin "now" to a Sunday-the-1st so a single test run exercises every tier.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T02:00:00.000Z")); // Sunday, 1st of Feb
});

afterAll(() => {
  vi.useRealTimers();
});

describe("runScheduledBackup", () => {
  it("returns ok:false with a structured reason when BACKUPS is unbound", async () => {
    const env = makeEnv({ bucket: undefined });
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/BACKUPS R2 bucket binding is not configured/);
  });

  it("surfaces a D1.dump() rejection without throwing", async () => {
    const bucket = new FakeR2Bucket();
    const env = makeEnv({
      db: new StubD1(new Error("D1 dump method not implemented on this backend")),
      bucket,
    });
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/D1.dump\(\) failed/);
    expect(bucket.putCalls).toHaveLength(0);
    expect(bucket.deleteCalls).toHaveLength(0);
  });

  it("uploads the dump into all three tiers when the date is Sunday + 1st", async () => {
    const bucket = new FakeR2Bucket();
    const env = makeEnv({ bucket });
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(true);
    expect(result.keys_uploaded).toEqual([
      "d1/daily/20260201T020000Z.sqlite",
      "d1/weekly/20260201T020000Z.sqlite",
      "d1/monthly/20260201T020000Z.sqlite",
    ]);
    expect(bucket.store.size).toBe(3);
    for (const [, obj] of bucket.store) {
      expect(obj.body.byteLength).toBe(64);
      expect(obj.customMetadata?.source).toBe("worker-cron");
    }
  });

  it("skips weekly + monthly on a non-qualifying date", async () => {
    vi.setSystemTime(new Date("2026-02-03T02:00:00.000Z")); // Tuesday, 3rd
    const bucket = new FakeR2Bucket();
    const env = makeEnv({ bucket });
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(true);
    expect(result.keys_uploaded).toEqual(["d1/daily/20260203T020000Z.sqlite"]);
    expect(bucket.store.size).toBe(1);

    // Restore the pinned date for any later assertions in this file.
    vi.setSystemTime(new Date("2026-02-01T02:00:00.000Z"));
  });

  it("retention sweep keeps the configured ceiling per tier and deletes the rest", async () => {
    const bucket = new FakeR2Bucket();
    // Seed 35 dailies (5 over the ceiling), 14 weeklies (2 over), 8 monthlies (2 over).
    // Older `uploaded` timestamps go later in the slice when sorted desc, so
    // the seeded oldest objects should be the ones deleted.
    const baseDay = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 35; i++) {
      bucket.seed(`d1/daily/2026-01-${String(i + 1).padStart(2, "0")}.sqlite`, new Date(baseDay + i * 86_400_000));
    }
    for (let i = 0; i < 14; i++) {
      bucket.seed(`d1/weekly/wk-${i}.sqlite`, new Date(baseDay + i * 7 * 86_400_000));
    }
    for (let i = 0; i < 8; i++) {
      bucket.seed(`d1/monthly/mo-${i}.sqlite`, new Date(baseDay + i * 30 * 86_400_000));
    }
    const env = makeEnv({ bucket });
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(true);
    // Kept = retain ceiling (30/12/6) plus the new uploads under daily/weekly/monthly.
    // Deleted by tier = total seeded above ceiling.
    expect(result.retention).toEqual([
      { tier: "daily", deleted: 6 },     // 35 seeded + 1 new = 36, retain 30, delete 6
      { tier: "weekly", deleted: 3 },    // 14 seeded + 1 new = 15, retain 12, delete 3
      { tier: "monthly", deleted: 3 },   // 8 seeded + 1 new = 9, retain 6, delete 3
    ]);
    // Spot-check: oldest seeded daily (2026-01-01) should be gone, newest (2026-02-04) should remain.
    expect(bucket.store.has("d1/daily/2026-01-01.sqlite")).toBe(false);
    expect(bucket.store.has("d1/daily/2026-01-31.sqlite")).toBe(true);
  });

  it("honors D1_BACKUP_RETAIN_* env overrides", async () => {
    const bucket = new FakeR2Bucket();
    const baseDay = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      bucket.seed(`d1/daily/d-${i}.sqlite`, new Date(baseDay + i * 86_400_000));
    }
    const env: Env = {
      ...makeEnv({ bucket }),
      D1_BACKUP_RETAIN_DAILY: "5",
    };
    const result = await runScheduledBackup(env);
    expect(result.ok).toBe(true);
    // 10 seeded + 1 new = 11, retain 5 → delete 6 in daily tier.
    expect(result.retention?.[0]).toEqual({ tier: "daily", deleted: 6 });
  });
});
