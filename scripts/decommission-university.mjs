#!/usr/bin/env node
// Tear down a customer university deployment provisioned by
// `scripts/provision-university.mjs` (sub-issue UNI-28).
//
// Removes:
//   - Pages project       `university-hub-<slug>-web` (incl. all deployments)
//   - Worker              `university-hub-<slug>` (revokes all secrets too)
//   - D1 database         `university-hub-<slug>` (deletes data — irreversible)
//   - Per-tenant config   `provisioning/<slug>/`
//
// This is destructive. The script REQUIRES `--confirm` AND a typed
// `--slug=<value>` match; without `--confirm` it dry-runs and prints what it
// would do, but never deletes.
//
// Usage:
//   node scripts/decommission-university.mjs --slug=acme --confirm
//
// Required environment:
//   - CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKER_DIR = resolve(REPO_ROOT, "apps/worker");
const PROVISIONING_DIR = resolve(REPO_ROOT, "provisioning");

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

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
  if (message) process.stderr.write(`decommission-university: ${message}\n\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/decommission-university.mjs --slug=<slug> --confirm",
      "",
      "Without --confirm the script lists what would be deleted and exits 0.",
      "Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.",
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
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (opts.stdin) child.stdin.end(opts.stdin);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
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
    cwd: opts.cwd ?? WORKER_DIR,
    ...opts,
  });
}

async function cfApi(method, path, body) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.");
  }
  const url = `https://api.cloudflare.com/client/v4${path.replace("{account}", account)}`;
  const init = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  let payload = null;
  try {
    payload = await res.json();
  } catch { /* ignore */ }
  if (!res.ok || (payload && payload.success === false)) {
    const errs = (payload?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API ${method} ${path} -> ${res.status}${errs ? ` (${errs})` : ""}`);
  }
  return payload?.result ?? payload;
}

function logStep(message) {
  process.stdout.write(`==> ${message}\n`);
}

function logSubstep(message) {
  process.stdout.write(`    ${message}\n`);
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// resource teardown

async function deletePagesProject(projectName, confirm) {
  logStep(`Pages project: ${projectName}`);
  // Look it up before attempting delete so the dry-run path can report
  // accurately and the destructive path skips when already gone.
  let exists = false;
  try {
    const projects = await cfApi("GET", "/accounts/{account}/pages/projects?per_page=100");
    exists = (Array.isArray(projects) ? projects : []).some((p) => p.name === projectName);
  } catch (err) {
    process.stderr.write(`  WARN: could not list Pages projects: ${err.message}\n`);
  }
  if (!exists) {
    logSubstep(`absent — skipping`);
    return;
  }
  if (!confirm) {
    logSubstep(`would delete (dry-run; pass --confirm to apply)`);
    return;
  }
  await cfApi("DELETE", `/accounts/{account}/pages/projects/${projectName}`);
  logSubstep(`deleted`);
}

async function deleteWorker(workerName, confirm) {
  logStep(`Worker: ${workerName}`);
  if (!confirm) {
    logSubstep(`would delete (dry-run; pass --confirm to apply)`);
    return;
  }
  // `wrangler delete --name=<x>` does not require a config file.
  try {
    await wrangler(["delete", `--name=${workerName}`], { stdin: "y\n", cwd: WORKER_DIR });
    logSubstep(`deleted`);
  } catch (err) {
    if (/not found/i.test(err.message) || /10007/.test(err.message)) {
      logSubstep(`absent — skipping`);
      return;
    }
    throw err;
  }
}

async function deleteD1(dbName, confirm) {
  logStep(`D1 database: ${dbName} (DESTRUCTIVE — drops all data)`);
  if (!confirm) {
    logSubstep(`would delete (dry-run; pass --confirm to apply)`);
    return;
  }
  try {
    await wrangler(["d1", "delete", dbName, "--skip-confirmation"], { cwd: WORKER_DIR });
    logSubstep(`deleted`);
  } catch (err) {
    // Older wrangler versions don't support --skip-confirmation; fall back
    // to piping a y\n.
    if (/unknown.*skip-confirmation/i.test(err.message) || /unrecognized/i.test(err.message)) {
      try {
        await wrangler(["d1", "delete", dbName], { stdin: "y\n", cwd: WORKER_DIR });
        logSubstep(`deleted`);
        return;
      } catch (err2) {
        if (/not found/i.test(err2.message)) {
          logSubstep(`absent — skipping`);
          return;
        }
        throw err2;
      }
    }
    if (/not found/i.test(err.message)) {
      logSubstep(`absent — skipping`);
      return;
    }
    throw err;
  }
}

async function deleteTenantConfig(slug, confirm) {
  const dir = resolve(PROVISIONING_DIR, slug);
  logStep(`Tenant config: ${dir}`);
  if (!(await pathExists(dir))) {
    logSubstep(`absent — skipping`);
    return;
  }
  if (!confirm) {
    logSubstep(`would remove ${dir} (dry-run; pass --confirm to apply)`);
    return;
  }
  await rm(dir, { recursive: true, force: true });
  logSubstep(`removed`);
}

// ---------------------------------------------------------------------------
// main

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage();

  const slug = (args.slug ?? "").trim().toLowerCase();
  const confirm = Boolean(args.confirm);

  if (!slug) usage("--slug is required");
  if (!SLUG_RE.test(slug)) usage(`slug must match ${SLUG_RE}`);
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    usage("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be exported");
  }

  const workerName = `university-hub-${slug}`;
  const dbName = `university-hub-${slug}`;
  const pagesProjectName = `university-hub-${slug}-web`;

  process.stdout.write(
    `decommission-university: ${slug}${confirm ? " — DESTRUCTIVE" : " — DRY RUN (pass --confirm to apply)"}\n\n`,
  );

  // Order: Pages -> Worker -> D1 -> tenant config.
  // Pages first so users immediately stop seeing the SPA. D1 last so any
  // last-minute "wait, can I export?" moment still has the data on hand.
  await deletePagesProject(pagesProjectName, confirm);
  await deleteWorker(workerName, confirm);
  await deleteD1(dbName, confirm);
  await deleteTenantConfig(slug, confirm);

  process.stdout.write(
    confirm
      ? `\ndecommission-university: ${slug} torn down.\n`
      : `\ndecommission-university: dry-run complete. Re-run with --confirm to apply.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`decommission-university: ${err.message}\n`);
  if (process.env.PROVISION_DEBUG === "1" && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
