#!/usr/bin/env node
// Backup the production D1 database to a Cloudflare R2 bucket (sub-issue
// UNI-27). Run from the repo root via `npm run backup:d1` or scheduled by
// a CI runner (see .github/workflows/d1-backup.yml).
//
// What it does:
//   1. `wrangler d1 export DB --remote --output=<tmp>.sql` against the
//      database bound in apps/worker/wrangler.toml.
//   2. Uploads the SQL dump to R2 under a date-stamped key. The same dump
//      is mirrored into `weekly/` on Sundays (UTC) and into `monthly/` on
//      the first day of the month, so a single export feeds all three
//      retention tiers without re-exporting.
//   3. Applies retention by listing R2 objects under each tier and deleting
//      anything older than the configured ceiling (30 dailies, 12 weeklies,
//      6 monthlies). This is belt + suspenders alongside the R2 lifecycle
//      rule documented in docs/disaster-recovery.md.
//
// Required environment:
//   - CLOUDFLARE_API_TOKEN     scoped to D1:Read + R2:Edit on the account
//   - CLOUDFLARE_ACCOUNT_ID    the same account that owns the D1 + R2 bucket
//
// Optional environment:
//   - D1_BACKUP_BUCKET         R2 bucket name (default: university-hub-backups)
//   - D1_BACKUP_PREFIX         key prefix inside the bucket (default: d1)
//   - D1_BACKUP_RETAIN_DAILY   integer (default: 30)
//   - D1_BACKUP_RETAIN_WEEKLY  integer (default: 12)
//   - D1_BACKUP_RETAIN_MONTHLY integer (default: 6)
//   - D1_BACKUP_DRY_RUN        "1" to skip the upload + delete steps
//
// Exits 0 on success. Any failure (export, upload, retention sweep) exits
// non-zero so the CI runner surfaces the failure. The dump file is left in
// the system temp dir on failure for forensics; on success it is removed.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKER_DIR = resolve(REPO_ROOT, "apps/worker");

const DEFAULTS = {
  bucket: "university-hub-backups",
  prefix: "d1",
  retainDaily: 30,
  retainWeekly: 12,
  retainMonthly: 6,
};

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function readEnv() {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!cfToken || !cfAccount) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set " +
        "(scoped to D1:Read + R2:Edit on the deploy account).",
    );
  }
  return {
    cfToken,
    cfAccount,
    bucket: process.env.D1_BACKUP_BUCKET || DEFAULTS.bucket,
    prefix: (process.env.D1_BACKUP_PREFIX || DEFAULTS.prefix).replace(/^\/+|\/+$/g, ""),
    retainDaily: readNumberEnv("D1_BACKUP_RETAIN_DAILY", DEFAULTS.retainDaily),
    retainWeekly: readNumberEnv("D1_BACKUP_RETAIN_WEEKLY", DEFAULTS.retainWeekly),
    retainMonthly: readNumberEnv("D1_BACKUP_RETAIN_MONTHLY", DEFAULTS.retainMonthly),
    dryRun: process.env.D1_BACKUP_DRY_RUN === "1",
  };
}

// ---------------------------------------------------------------------------
// Subprocess helpers
//
// Wrangler is invoked via `npx wrangler` from inside apps/worker/ so it picks
// up the [[d1_databases]] / [[r2_buckets]] bindings declared in wrangler.toml.
// stderr is captured and re-printed on failure so CI logs include wrangler's
// actual error message.

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const err = new Error(
          `${cmd} ${args.join(" ")} exited ${code}\n--- stderr ---\n${stderr.trim()}\n--- stdout ---\n${stdout.trim()}`,
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        rejectPromise(err);
      }
    });
  });
}

async function wrangler(args, opts = {}) {
  return run("npx", ["--no-install", "wrangler", ...args], {
    cwd: WORKER_DIR,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Date / key helpers

function isoStampUtc(date) {
  // 2026-05-04T020000Z — sortable and filename-safe.
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function isoDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function tierTargets(date, prefix) {
  // The same SQL dump is mirrored into multiple tiers when the date qualifies
  // (Sunday → weekly; first of month → monthly). The retention sweep below
  // operates per-tier, so each tier ages out on its own schedule.
  const stamp = isoStampUtc(date);
  const dailyKey = `${prefix}/daily/${stamp}.sql`;
  const targets = [{ tier: "daily", key: dailyKey }];
  if (date.getUTCDay() === 0) {
    targets.push({ tier: "weekly", key: `${prefix}/weekly/${stamp}.sql` });
  }
  if (date.getUTCDate() === 1) {
    targets.push({ tier: "monthly", key: `${prefix}/monthly/${stamp}.sql` });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// R2 operations
//
// `wrangler r2 object put/delete --remote` for the writes (auth flows through
// CLOUDFLARE_API_TOKEN automatically). Listing goes through the Cloudflare
// REST API directly because `wrangler r2 object list` does not exist as of
// wrangler 4.87 — `wrangler r2` exposes only get/put/delete on objects.

async function r2Put(bucket, key, filePath) {
  await wrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    `--file=${filePath}`,
    "--content-type=application/sql",
    "--remote",
  ]);
}

async function r2Delete(bucket, key) {
  await wrangler([
    "r2",
    "object",
    "delete",
    `${bucket}/${key}`,
    "--remote",
  ]);
}

async function r2ListPrefix(env, prefix) {
  // GET /accounts/{id}/r2/buckets/{name}/objects?prefix=...&cursor=...
  // Returns { success, result: [{ key, last_modified, size, ... }],
  // result_info: { cursor } }. We walk the cursor until exhausted.
  const objects = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${env.cfAccount}/r2/buckets/${env.bucket}/objects`,
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.cfToken}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`r2 list ${prefix} failed: HTTP ${resp.status}\n${body}`);
    }
    const payload = await resp.json();
    if (payload.success === false) {
      throw new Error(
        `r2 list ${prefix} failed: ${JSON.stringify(payload.errors ?? payload)}`,
      );
    }
    for (const entry of payload.result ?? []) objects.push(entry);
    cursor = payload.result_info?.cursor;
    if (!cursor) break;
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Retention sweep
//
// For each tier, sort by uploaded date desc and keep the newest N; delete
// the rest. Errors on a single delete are logged and counted so a transient
// R2 hiccup doesn't take down the whole run, but any failure flips the
// process exit code via `failures > 0`.

async function sweepTier(env, tier, retain) {
  const prefix = `${env.prefix}/${tier}/`;
  const objects = await r2ListPrefix(env, prefix);
  objects.sort((a, b) => {
    const ua = Date.parse(a.uploaded ?? a.last_modified ?? 0);
    const ub = Date.parse(b.uploaded ?? b.last_modified ?? 0);
    return ub - ua;
  });
  const toDelete = objects.slice(retain);
  let failures = 0;
  for (const obj of toDelete) {
    try {
      if (env.dryRun) {
        console.log(`[dry-run] would delete ${env.bucket}/${obj.key}`);
      } else {
        await r2Delete(env.bucket, obj.key);
        console.log(`[retention] deleted ${env.bucket}/${obj.key}`);
      }
    } catch (err) {
      failures += 1;
      console.error(`[retention] failed to delete ${obj.key}: ${err.message}`);
    }
  }
  return { tier, kept: Math.min(objects.length, retain), deleted: toDelete.length - failures, failures };
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const env = readEnv();
  const startedAt = new Date();
  const stamp = isoStampUtc(startedAt);
  const dateLabel = isoDateUtc(startedAt);

  console.log(`[backup-d1] starting ${stamp} (UTC) → bucket=${env.bucket} prefix=${env.prefix}`);

  // 1. Export the remote D1 to a local SQL dump.
  const workdir = await mkdtemp(join(tmpdir(), "d1-backup-"));
  const dumpPath = join(workdir, `d1-${dateLabel}.sql`);
  console.log(`[backup-d1] exporting D1 → ${dumpPath}`);
  await wrangler(["d1", "export", "DB", "--remote", `--output=${dumpPath}`]);
  const fileStat = await stat(dumpPath);
  const sha256 = createHash("sha256").update(await readFile(dumpPath)).digest("hex");
  console.log(`[backup-d1] dump size=${fileStat.size}B sha256=${sha256}`);

  // 2. Upload to each qualifying tier under its own key.
  const targets = tierTargets(startedAt, env.prefix);
  const uploaded = [];
  for (const target of targets) {
    const fullKey = target.key;
    if (env.dryRun) {
      console.log(`[backup-d1] [dry-run] would upload → r2://${env.bucket}/${fullKey}`);
      uploaded.push({ ...target, dryRun: true });
      continue;
    }
    console.log(`[backup-d1] uploading → r2://${env.bucket}/${fullKey}`);
    await r2Put(env.bucket, fullKey, dumpPath);
    uploaded.push(target);
  }

  // 3. Retention sweep — done after upload so we never delete the freshest
  //    object before its replacement is in place.
  const retentionResults = [];
  retentionResults.push(await sweepTier(env, "daily", env.retainDaily));
  retentionResults.push(await sweepTier(env, "weekly", env.retainWeekly));
  retentionResults.push(await sweepTier(env, "monthly", env.retainMonthly));

  // 4. Clean up local dump on success only — leaving it around on failure
  //    helps debug from the CI runner before the workspace is destroyed.
  await rm(workdir, { recursive: true, force: true });

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const summary = {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    bucket: env.bucket,
    prefix: env.prefix,
    dump_bytes: fileStat.size,
    dump_sha256: sha256,
    tiers_uploaded: uploaded,
    retention: retentionResults,
    dry_run: env.dryRun,
  };
  console.log(`[backup-d1] done\n${JSON.stringify(summary, null, 2)}`);

  const totalFailures = retentionResults.reduce((acc, r) => acc + r.failures, 0);
  if (totalFailures > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`[backup-d1] FAILED: ${err.message}`);
  process.exit(1);
});
