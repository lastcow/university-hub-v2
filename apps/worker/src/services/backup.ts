// In-Worker D1 → R2 backup, invoked from the daily Cron Trigger declared in
// wrangler.toml (sub-issue UNI-27). This is the **defense-in-depth** path:
// the canonical, reliable scheduler is the GitHub Actions workflow at
// `.github/workflows/d1-backup.yml` which calls `wrangler d1 export` from a
// CI runner.  A customer who hasn't wired up GitHub Actions still gets at
// least one backup per day from this Worker cron, provided their D1 backend
// supports `D1.dump()`.
//
// Caveats:
//   - `D1.dump()` returns the entire database as a SQLite ArrayBuffer. On
//     the GA D1 backend this method is *not* universally supported and may
//     reject with "not implemented" / "deprecated".  We treat the rejection
//     as a recoverable, audit-logged failure: the cron run completes 2xx
//     so the Worker doesn't go into an alert loop, and the customer is
//     pointed at the GitHub Actions path via docs/disaster-recovery.md.
//   - The output is the SQLite binary file (not the SQL text format that
//     `wrangler d1 export` produces). Either format is restorable: SQLite
//     binaries are restored by replacing the D1 backend file or by running
//     `sqlite3 dump.db .dump | wrangler d1 execute ...`. The DR doc covers
//     both shapes.
//
// The retention sweep here mirrors `scripts/backup-d1.mjs` so daily/weekly/
// monthly tiers age out the same way regardless of which scheduler ran.

import type { Env } from "../env.js";

export interface BackupResult {
  ok: boolean;
  reason?: string;
  bucket?: string;
  keys_uploaded?: string[];
  bytes?: number;
  duration_ms?: number;
  retention?: Array<{ tier: string; deleted: number }>;
}

interface BackupBindings {
  DB: D1Database;
  BACKUPS?: R2Bucket;
}

const DEFAULT_PREFIX = "d1";
const DEFAULT_RETAIN = { daily: 30, weekly: 12, monthly: 6 } as const;

function intEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function isoStampUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function tierTargets(date: Date, prefix: string): Array<{ tier: "daily" | "weekly" | "monthly"; key: string }> {
  const stamp = isoStampUtc(date);
  const targets: Array<{ tier: "daily" | "weekly" | "monthly"; key: string }> = [
    { tier: "daily", key: `${prefix}/daily/${stamp}.sqlite` },
  ];
  if (date.getUTCDay() === 0) {
    targets.push({ tier: "weekly", key: `${prefix}/weekly/${stamp}.sqlite` });
  }
  if (date.getUTCDate() === 1) {
    targets.push({ tier: "monthly", key: `${prefix}/monthly/${stamp}.sqlite` });
  }
  return targets;
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...listed.objects);
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }
  return out;
}

async function sweepTier(
  bucket: R2Bucket,
  prefix: string,
  tier: "daily" | "weekly" | "monthly",
  retain: number,
): Promise<{ tier: string; deleted: number }> {
  const objects = await listAll(bucket, `${prefix}/${tier}/`);
  objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  const toDelete = objects.slice(retain);
  for (const obj of toDelete) {
    await bucket.delete(obj.key);
  }
  return { tier, deleted: toDelete.length };
}

export async function runScheduledBackup(env: Env): Promise<BackupResult> {
  const startedAt = Date.now();
  const bindings = env as unknown as BackupBindings;

  if (!bindings.BACKUPS) {
    return {
      ok: false,
      reason:
        "BACKUPS R2 bucket binding is not configured. " +
        "Either set up the R2 bucket per docs/disaster-recovery.md or rely on the GitHub Actions workflow.",
    };
  }

  const prefix = (env.D1_BACKUP_PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
  const retain = {
    daily: intEnv(env.D1_BACKUP_RETAIN_DAILY, DEFAULT_RETAIN.daily),
    weekly: intEnv(env.D1_BACKUP_RETAIN_WEEKLY, DEFAULT_RETAIN.weekly),
    monthly: intEnv(env.D1_BACKUP_RETAIN_MONTHLY, DEFAULT_RETAIN.monthly),
  };

  // 1. Dump the database.
  let dump: ArrayBuffer;
  try {
    dump = await bindings.DB.dump();
  } catch (err) {
    // D1.dump() is not supported on every backend — when that happens we
    // surface the failure in a structured form and rely on the GitHub
    // Actions path for the day's backup.
    return {
      ok: false,
      reason: `D1.dump() failed: ${(err as Error).message}. Falling back to the GitHub Actions backup path.`,
    };
  }

  // 2. Upload to each qualifying tier.
  const targets = tierTargets(new Date(startedAt), prefix);
  const keysUploaded: string[] = [];
  for (const target of targets) {
    await bindings.BACKUPS.put(target.key, dump, {
      httpMetadata: { contentType: "application/vnd.sqlite3" },
      customMetadata: {
        source: "worker-cron",
        scheduled_at: new Date(startedAt).toISOString(),
        tier: target.tier,
      },
    });
    keysUploaded.push(target.key);
  }

  // 3. Retention sweep — same per-tier ceilings as backup-d1.mjs.
  const retention = [
    await sweepTier(bindings.BACKUPS, prefix, "daily", retain.daily),
    await sweepTier(bindings.BACKUPS, prefix, "weekly", retain.weekly),
    await sweepTier(bindings.BACKUPS, prefix, "monthly", retain.monthly),
  ];

  return {
    ok: true,
    bucket: env.D1_BACKUP_BUCKET ?? "(R2 binding)",
    keys_uploaded: keysUploaded,
    bytes: dump.byteLength,
    duration_ms: Date.now() - startedAt,
    retention,
  };
}
