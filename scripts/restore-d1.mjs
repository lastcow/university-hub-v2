#!/usr/bin/env node
// Restore a D1 SQL dump from R2 into a target D1 database (sub-issue UNI-27).
// Used by the disaster-recovery runbook (docs/disaster-recovery.md) and by
// the periodic restore drill against a scratch D1.
//
// IMPORTANT — by default this script refuses to touch the production
// database (`university-hub-v2`). To restore over production you must pass
// `--i-understand-this-overwrites-prod` AND name the target explicitly. The
// expected use is to restore into a SCRATCH database (e.g.
// `university-hub-v2-scratch`) and only switch DNS / bindings once the
// restored copy has been verified.
//
// Usage:
//   node scripts/restore-d1.mjs \
//     --target=<d1-database-name> \
//     [--key=<r2-key>] \
//     [--latest=<tier>]            # daily | weekly | monthly
//     [--bucket=<r2-bucket>] \
//     [--local]                    # restore into a local sqlite, not remote
//     [--no-counts]                # skip the row-count comparison
//     [--i-understand-this-overwrites-prod]
//
// Required environment (mirrors backup-d1.mjs):
//   - CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — for remote restores.
//
// What it does:
//   1. If --latest is set, lists the matching tier in R2 and picks the
//      newest object; otherwise uses --key.
//   2. Downloads the dump to a temp dir.
//   3. Captures pre-restore row counts on the target (for the comparison
//      report at the end).
//   4. Runs `wrangler d1 execute <target> --file=<dump> [--remote|--local]`.
//   5. Captures post-restore row counts and prints a side-by-side diff.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKER_DIR = resolve(REPO_ROOT, "apps/worker");

const PROD_DB_NAME = "university-hub-v2";
const DEFAULT_BUCKET = "university-hub-backups";
const DEFAULT_PREFIX = "d1";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function usage(message) {
  if (message) process.stderr.write(`restore-d1: ${message}\n\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/restore-d1.mjs --target=<d1-name> --latest=daily",
      "  node scripts/restore-d1.mjs --target=<d1-name> --key=d1/daily/2026-05-04T020000Z.sql",
      "",
      "Restoring into the production database is gated behind",
      "--i-understand-this-overwrites-prod. The drill should always target a",
      "scratch D1 (e.g. `university-hub-v2-scratch`) — see docs/disaster-recovery.md.",
      "",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

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
        rejectPromise(err);
      }
    });
  });
}

async function wrangler(args) {
  return run("npx", ["--no-install", "wrangler", ...args], { cwd: WORKER_DIR });
}

async function listTier(bucket, prefix, tier) {
  const args = [
    "r2",
    "object",
    "list",
    bucket,
    `--prefix=${prefix}/${tier}/`,
    "--per-page=1000",
    "--remote",
    "--output=json",
  ];
  const { stdout } = await wrangler(args);
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(`r2 object list returned non-JSON output:\n${stdout}`);
    }
    payload = JSON.parse(stdout.slice(start, end + 1));
  }
  return payload.result ?? payload.objects ?? [];
}

async function downloadObject(bucket, key, dest) {
  await wrangler([
    "r2",
    "object",
    "get",
    `${bucket}/${key}`,
    `--file=${dest}`,
    "--remote",
  ]);
}

// `wrangler d1 execute --command "SELECT ..." --json` returns a structured
// payload like `[{ results: [{ name, n }, ...] }]`. We tolerate small
// variations across wrangler versions by walking the first row of the first
// result set.
async function rowCounts(target, scope) {
  const sql =
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  const tablesOut = await wrangler([
    "d1",
    "execute",
    target,
    scope,
    `--command=${sql}`,
    "--json",
  ]);
  const tablesPayload = JSON.parse(tablesOut.stdout);
  const tablesRows =
    tablesPayload?.[0]?.results ?? tablesPayload?.results ?? [];
  const tables = tablesRows
    .map((r) => r.name)
    .filter((n) => typeof n === "string" && n.length > 0);

  const counts = {};
  for (const table of tables) {
    const out = await wrangler([
      "d1",
      "execute",
      target,
      scope,
      `--command=SELECT COUNT(*) AS n FROM "${table}"`,
      "--json",
    ]);
    let payload;
    try {
      payload = JSON.parse(out.stdout);
    } catch {
      counts[table] = null;
      continue;
    }
    const row = payload?.[0]?.results?.[0] ?? payload?.results?.[0];
    counts[table] = row && typeof row.n === "number" ? row.n : null;
  }
  return counts;
}

function diffCounts(before, after) {
  const tables = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rows = [];
  for (const table of [...tables].sort()) {
    rows.push({
      table,
      before: before[table] ?? 0,
      after: after[table] ?? 0,
      delta: (after[table] ?? 0) - (before[table] ?? 0),
    });
  }
  return rows;
}

function renderTable(rows) {
  const header = ["table", "before", "after", "delta"];
  const data = [header, ...rows.map((r) => [r.table, String(r.before), String(r.after), String(r.delta)])];
  const widths = header.map((_, i) => Math.max(...data.map((row) => row[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(data[0]), widths.map((w) => "-".repeat(w)).join("  "), ...data.slice(1).map(fmt)].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage();

  const target = args.target;
  if (!target) usage("--target is required");

  if (target === PROD_DB_NAME && !args["i-understand-this-overwrites-prod"]) {
    usage(
      `Refusing to restore into the production database '${PROD_DB_NAME}' without --i-understand-this-overwrites-prod. ` +
        "Restore into a scratch D1 first and verify before switching bindings.",
    );
  }

  const bucket = args.bucket || DEFAULT_BUCKET;
  const prefix = (args.prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
  const scope = args.local ? "--local" : "--remote";

  // Resolve the source key (either explicit --key or newest-in-tier).
  let key = args.key;
  if (!key) {
    const tier = args.latest;
    if (!tier || !["daily", "weekly", "monthly"].includes(tier)) {
      usage("Pass either --key=<r2-key> or --latest=<daily|weekly|monthly>");
    }
    const objects = await listTier(bucket, prefix, tier);
    if (objects.length === 0) {
      throw new Error(`No backups found under ${prefix}/${tier}/ in ${bucket}.`);
    }
    objects.sort((a, b) => {
      const ua = Date.parse(a.uploaded ?? a.last_modified ?? 0);
      const ub = Date.parse(b.uploaded ?? b.last_modified ?? 0);
      return ub - ua;
    });
    key = objects[0].key;
    console.log(`[restore-d1] latest ${tier} backup → ${key}`);
  }

  const workdir = await mkdtemp(join(tmpdir(), "d1-restore-"));
  const dumpPath = join(workdir, "dump.sql");

  if (args.local) {
    // For --local restores we still pull the dump out of R2 (the operator
    // wants to drill against real backup contents); R2 access requires the
    // remote API token.
  }

  console.log(`[restore-d1] downloading r2://${bucket}/${key} → ${dumpPath}`);
  await downloadObject(bucket, key, dumpPath);
  const fileStat = await stat(dumpPath);
  console.log(`[restore-d1] dump size=${fileStat.size}B`);

  let before = {};
  let after = {};
  if (!args["no-counts"]) {
    console.log(`[restore-d1] capturing pre-restore row counts on ${target} ${scope}`);
    try {
      before = await rowCounts(target, scope);
    } catch (err) {
      console.warn(`[restore-d1] pre-restore counts failed (target may not exist yet): ${err.message}`);
      before = {};
    }
  }

  console.log(`[restore-d1] applying dump to ${target} ${scope}`);
  await wrangler(["d1", "execute", target, scope, `--file=${dumpPath}`]);

  if (!args["no-counts"]) {
    console.log(`[restore-d1] capturing post-restore row counts on ${target}`);
    after = await rowCounts(target, scope);
    const rows = diffCounts(before, after);
    console.log("\n[restore-d1] row count comparison:\n");
    console.log(renderTable(rows));
    console.log("");
  }

  await rm(workdir, { recursive: true, force: true });
  console.log("[restore-d1] done");
}

main().catch((err) => {
  console.error(`[restore-d1] FAILED: ${err.message}`);
  process.exit(1);
});
