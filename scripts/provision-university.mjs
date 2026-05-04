#!/usr/bin/env node
// Provision a complete University Hub deployment for a new customer
// university — D1, Worker, Pages, secrets, optional custom domain.
// Single-tenant per university (epic UNI-21 / sub-issue UNI-28).
//
// One run produces a working customer instance:
//   - D1 database     `university-hub-<slug>`
//   - Worker          `university-hub-<slug>`
//   - Pages project   `university-hub-<slug>-web`
//   - Per-tenant config under `provisioning/<slug>/wrangler.toml`
//   - All required Worker secrets set
//   - Migrations 0001/0002/0004/0005/0006 applied (NOT 0003 dev seed)
//   - Bootstrapped super_admin for the supplied admin email
//
// Re-running with the same inputs is a no-op: every step checks for the
// resource first and skips creation. Resources that already exist are
// reported as "exists"; missing pieces are filled in. Bootstrap is skipped
// if a super_admin already exists on the new D1.
//
// Usage:
//   node scripts/provision-university.mjs \
//     --name="Acme University" \
//     --slug=acme \
//     --admin-email=admin@acme.edu \
//     --admin-name="Site Admin" \
//     [--custom-domain=hub.acme.edu] \
//     [--app-base-url=https://hub.acme.edu] \
//     [--mailgun-api-key=...] \
//     [--mailgun-domain=mg.acme.edu] \
//     [--mailgun-from-email=no-reply@mg.acme.edu] \
//     [--mailgun-from-name="Acme University"] \
//     [--mailgun-region=US|EU] \
//     [--support-email=support@acme.edu] \
//     [--password-env=ADMIN_PASSWORD] \
//     [--skip-bootstrap] \
//     [--skip-pages-deploy] \
//     [--dry-run]
//
// Required environment:
//   - CLOUDFLARE_API_TOKEN     scoped for D1, Workers, Pages on the account
//   - CLOUDFLARE_ACCOUNT_ID    target Cloudflare account
//
// Outputs (printed at the end):
//   - Worker URL
//   - Pages URL
//   - Custom domain status (if requested)
//   - Bootstrap admin credentials (one-time temporary password unless
//     --password-env was supplied)
//
// Companion `scripts/decommission-university.mjs` removes everything this
// script creates.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORKER_DIR = resolve(REPO_ROOT, "apps/worker");
const WEB_DIR = resolve(REPO_ROOT, "apps/web");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "migrations");
const PROVISIONING_DIR = resolve(REPO_ROOT, "provisioning");

const SEED_MIGRATION_FILE = "0003_seed_dev_data.sql";

// Slugs become subdomains (`<slug>.<base>.workers.dev`, `<slug>.universityhub.io`).
// Reserved names are operator/SaaS-level routes that must never be a tenant.
const RESERVED_SLUGS = new Set([
  "api", "admin", "app", "dashboard", "auth", "login", "signin", "sign-in",
  "signup", "sign-up", "support", "docs", "help", "status", "www", "marketing",
  "internal", "ops", "saas", "root", "super", "test", "staging", "preview",
  "university-hub", "university-hub-v2", "universityhub",
]);
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// arg parsing

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
  if (message) process.stderr.write(`provision-university: ${message}\n\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/provision-university.mjs \\",
      "    --name=\"Acme University\" \\",
      "    --slug=acme \\",
      "    --admin-email=admin@acme.edu \\",
      "    --admin-name=\"Site Admin\" \\",
      "    [--custom-domain=hub.acme.edu] \\",
      "    [--app-base-url=https://hub.acme.edu] \\",
      "    [--mailgun-api-key=... --mailgun-domain=... \\",
      "     --mailgun-from-email=... --mailgun-from-name=...] \\",
      "    [--password-env=ADMIN_PASSWORD] \\",
      "    [--skip-bootstrap] [--skip-pages-deploy] [--dry-run]",
      "",
      "Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.",
      "",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

function validateSlug(slug) {
  if (!slug) return "slug is required";
  if (!SLUG_RE.test(slug)) {
    return `slug must match ${SLUG_RE} (lowercase letters/digits/hyphens, 3-32 chars, no leading/trailing hyphen)`;
  }
  if (slug.includes("--")) return "slug must not contain consecutive hyphens";
  if (RESERVED_SLUGS.has(slug)) return `slug "${slug}" is reserved`;
  return null;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// subprocess

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
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

// ---------------------------------------------------------------------------
// Cloudflare REST helper
//
// `wrangler` covers most of what we need, but a few things — looking up the
// account's workers.dev subdomain, attaching a Pages custom domain — are
// only exposed via the REST API. We use it sparingly and never log the
// API token.

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
  } catch {
    // ignore
  }
  if (!res.ok || (payload && payload.success === false)) {
    const errs = (payload?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API ${method} ${path} -> ${res.status}${errs ? ` (${errs})` : ""}`);
  }
  return payload?.result ?? payload;
}

// ---------------------------------------------------------------------------
// step helpers

function logStep(message) {
  process.stdout.write(`==> ${message}\n`);
}

function logSubstep(message) {
  process.stdout.write(`    ${message}\n`);
}

function generateRandomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// Temporary admin password. Avoid look-alike chars so an operator can read
// it from a terminal. The bootstrap endpoint requires >= 8 chars; we ship
// 16 so there's no chance of running short after future tweaks.
function generateTempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(16);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}

// ---------------------------------------------------------------------------
// resource discovery

async function findD1Database(name) {
  // `wrangler d1 list --json` returns an array of { uuid, name, ... }.
  const { stdout } = await wrangler(["d1", "list", "--json"]);
  let list;
  try {
    list = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start === -1 || end === -1) {
      throw new Error(`d1 list returned non-JSON output:\n${stdout}`);
    }
    list = JSON.parse(stdout.slice(start, end + 1));
  }
  const match = (Array.isArray(list) ? list : []).find((r) => r.name === name);
  if (!match) return null;
  return { id: match.uuid ?? match.id ?? match.database_id, name: match.name };
}

async function findPagesProject(name) {
  // `wrangler pages project list` does not consistently expose --json across
  // versions, so we hit the REST API directly.
  const projects = await cfApi("GET", "/accounts/{account}/pages/projects?per_page=100");
  const list = Array.isArray(projects) ? projects : [];
  return list.find((p) => p.name === name) ?? null;
}

async function getWorkersSubdomain() {
  const result = await cfApi("GET", "/accounts/{account}/workers/subdomain");
  return result?.subdomain ?? null;
}

// ---------------------------------------------------------------------------
// step: D1

async function provisionD1(env, slug, dryRun) {
  const dbName = `university-hub-${slug}`;
  logStep(`D1 database: ${dbName}`);
  const existing = await findD1Database(dbName);
  if (existing) {
    logSubstep(`exists (${existing.id}) — skipping create`);
    return { name: dbName, id: existing.id, created: false };
  }
  if (dryRun) {
    logSubstep(`[dry-run] would create D1 ${dbName}`);
    return { name: dbName, id: "<pending>", created: true };
  }
  const { stdout } = await wrangler(["d1", "create", dbName]);
  // Wrangler prints the database_id either in a table or in JSON-like text.
  // It also accepts `--json` post-3.x; older builds may not honour it. Try
  // `findD1Database` again rather than parsing the human output.
  const created = await findD1Database(dbName);
  if (!created) {
    throw new Error(`d1 create ${dbName} succeeded but the database is not visible in d1 list:\n${stdout}`);
  }
  logSubstep(`created (${created.id})`);
  return { name: dbName, id: created.id, created: true };
}

// ---------------------------------------------------------------------------
// step: per-tenant wrangler.toml

function renderWranglerToml({
  workerName,
  dbName,
  dbId,
  appBaseUrl,
  allowedOrigins,
  migrationsDir,
}) {
  return `# Generated by scripts/provision-university.mjs (UNI-28).
# Do not edit by hand. Re-run the provision script with --upgrade to refresh.

name = "${workerName}"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[vars]
APP_ENV = "production"
APP_BASE_URL = "${appBaseUrl}"
ALLOWED_WEB_ORIGINS = "${allowedOrigins}"

[[d1_databases]]
binding = "DB"
database_name = "${dbName}"
database_id = "${dbId}"
migrations_dir = "${migrationsDir}"
`;
}

async function writeTenantConfig(slug, contents) {
  const tenantDir = resolve(PROVISIONING_DIR, slug);
  await mkdir(tenantDir, { recursive: true });
  const path = resolve(tenantDir, "wrangler.toml");
  await writeFile(path, contents, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// step: migrations

// Stage migrations into a temp dir, dropping the dev-seed file. Returns the
// path so the caller can point a transient wrangler config at it.
async function stageNonSeedMigrations() {
  const dir = await mkdtemp(join(tmpdir(), "uni-hub-migrations-"));
  const files = await readdir(MIGRATIONS_DIR);
  for (const file of files.sort()) {
    if (file === SEED_MIGRATION_FILE) continue;
    if (!file.endsWith(".sql")) continue;
    await copyFile(resolve(MIGRATIONS_DIR, file), resolve(dir, file));
  }
  return dir;
}

async function applyMigrations({ dbName, workerName, dryRun }) {
  logStep(`Applying schema migrations to ${dbName} (skipping ${SEED_MIGRATION_FILE})`);
  if (dryRun) {
    const files = await readdir(MIGRATIONS_DIR);
    const applied = files
      .filter((f) => f.endsWith(".sql") && f !== SEED_MIGRATION_FILE)
      .sort();
    logSubstep(`[dry-run] would apply ${applied.length} migrations: ${applied.join(", ")}`);
    return;
  }

  const stagingDir = await stageNonSeedMigrations();
  const tomlContents = `# Transient — used only to point wrangler d1 migrations apply at the
# subset of migrations that should run against a brand-new tenant DB.
name = "${workerName}"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "${dbName}"
migrations_dir = "${stagingDir}"
`;
  const tomlPath = resolve(stagingDir, "wrangler.toml");
  await writeFile(tomlPath, tomlContents, "utf8");

  try {
    // Pipe `y` so wrangler's interactive "are you sure?" prompt does not
    // block in a non-TTY runner.
    await wrangler(
      ["d1", "migrations", "apply", "DB", "--remote", `--config=${tomlPath}`],
      { cwd: WORKER_DIR, stdin: "y\n" },
    );
    logSubstep(`migrations applied`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// step: Worker secrets

async function putSecret({ workerName, name, value, configPath, dryRun }) {
  if (dryRun) {
    logSubstep(`[dry-run] would set secret ${name}`);
    return;
  }
  await wrangler(
    ["secret", "put", name, `--name=${workerName}`, `--config=${configPath}`],
    { cwd: WORKER_DIR, stdin: value + "\n" },
  );
}

async function deleteSecret({ workerName, name, configPath, dryRun }) {
  if (dryRun) {
    logSubstep(`[dry-run] would delete secret ${name}`);
    return;
  }
  try {
    await wrangler(
      ["secret", "delete", name, `--name=${workerName}`, `--config=${configPath}`],
      { cwd: WORKER_DIR, stdin: "y\n" },
    );
  } catch (err) {
    // Cloudflare returns 404 if the secret doesn't exist; treat as no-op.
    if (/not found/i.test(err.message) || /10056/.test(err.message)) {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// step: Worker deploy

async function deployWorker({ configPath, workerName, dryRun }) {
  logStep(`Worker deploy: ${workerName}`);
  if (dryRun) {
    logSubstep(`[dry-run] would deploy worker via wrangler deploy --config=${configPath}`);
    return;
  }
  await wrangler(["deploy", `--config=${configPath}`], { cwd: WORKER_DIR });
  logSubstep(`deployed`);
}

// ---------------------------------------------------------------------------
// step: Pages project

async function provisionPages({ slug, dryRun }) {
  const projectName = `university-hub-${slug}-web`;
  logStep(`Pages project: ${projectName}`);
  const existing = await findPagesProject(projectName);
  if (existing) {
    logSubstep(`exists — skipping create`);
    return { name: projectName, created: false, project: existing };
  }
  if (dryRun) {
    logSubstep(`[dry-run] would create Pages project ${projectName}`);
    return { name: projectName, created: true, project: null };
  }
  const project = await cfApi("POST", "/accounts/{account}/pages/projects", {
    name: projectName,
    production_branch: "main",
  });
  logSubstep(`created`);
  return { name: projectName, created: true, project };
}

async function buildAndDeployPages({ projectName, workerUrl, skipDeploy, dryRun }) {
  if (skipDeploy) {
    logStep(`Pages deploy: skipped (--skip-pages-deploy)`);
    return null;
  }
  logStep(`Building SPA with VITE_API_BASE_URL=${workerUrl}`);
  if (dryRun) {
    logSubstep(`[dry-run] would run npm run build and wrangler pages deploy`);
    return null;
  }
  await run("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    env: { VITE_API_BASE_URL: workerUrl },
  });
  logStep(`Pages deploy: ${projectName}`);
  const { stdout } = await wrangler(
    [
      "pages",
      "deploy",
      resolve(WEB_DIR, "dist"),
      `--project-name=${projectName}`,
      "--branch=main",
    ],
    { cwd: REPO_ROOT },
  );
  // Wrangler prints something like "Deployment complete! Take a peek over at https://<sha>.<project>.pages.dev"
  const m = stdout.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
  const deploymentUrl = m ? m[0] : `https://${projectName}.pages.dev`;
  logSubstep(`deployed -> ${deploymentUrl}`);
  return deploymentUrl;
}

// ---------------------------------------------------------------------------
// step: custom domain

async function attachPagesDomain({ projectName, domain, dryRun }) {
  logStep(`Pages custom domain: ${domain}`);
  if (dryRun) {
    logSubstep(`[dry-run] would attach ${domain} to ${projectName}`);
    return;
  }
  // Idempotent — POST returns 409 if the domain is already attached.
  try {
    await cfApi(
      "POST",
      `/accounts/{account}/pages/projects/${projectName}/domains`,
      { name: domain },
    );
    logSubstep(`attached (Cloudflare will issue a certificate; CNAME ${domain} -> ${projectName}.pages.dev)`);
  } catch (err) {
    if (/already exists/i.test(err.message) || /8000016/.test(err.message)) {
      logSubstep(`already attached — skipping`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// step: bootstrap admin

async function checkSuperAdminExists({ dbName }) {
  // Direct D1 SELECT — avoids hitting the deployed Worker before secrets
  // are warmed up. Returns true if any super_admin row already exists.
  const { stdout } = await wrangler([
    "d1",
    "execute",
    dbName,
    "--remote",
    "--command=SELECT id FROM users WHERE role='super_admin' LIMIT 1",
    "--json",
  ]);
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return false;
  }
  const rows = payload?.[0]?.results ?? payload?.results ?? [];
  return Array.isArray(rows) && rows.length > 0;
}

async function bootstrapAdmin({
  workerName,
  workerUrl,
  configPath,
  email,
  name,
  universityName,
  passwordEnvName,
  dryRun,
  dbName,
}) {
  logStep(`Bootstrap super_admin: ${email}`);
  if (dryRun) {
    logSubstep(`[dry-run] would set BOOTSTRAP_SECRET, call /api/bootstrap/super-admin, then delete secret`);
    return { skipped: false, password: null };
  }

  const alreadyBootstrapped = await checkSuperAdminExists({ dbName });
  if (alreadyBootstrapped) {
    logSubstep(`super_admin already exists — skipping`);
    return { skipped: true, password: null };
  }

  let password;
  let passwordSource;
  if (passwordEnvName) {
    password = process.env[passwordEnvName];
    if (!password) {
      throw new Error(`--password-env=${passwordEnvName} is set but the env var is empty`);
    }
    passwordSource = "env";
  } else {
    password = generateTempPassword();
    passwordSource = "generated";
  }

  const bootstrapSecret = generateRandomHex(32);
  await putSecret({
    workerName,
    name: "BOOTSTRAP_SECRET",
    value: bootstrapSecret,
    configPath,
    dryRun: false,
  });

  // Cloudflare secret puts propagate within seconds; give the edge a brief
  // window before the first call so the new secret is live.
  await new Promise((r) => setTimeout(r, 3_000));

  const endpoint = new URL("/api/bootstrap/super-admin", workerUrl).toString();
  const body = { email, name, password, university_name: universityName };
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bootstrapSecret}`,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // Best-effort: still try to remove the secret so we don't leave a key
    // behind on the Worker.
    await deleteSecret({ workerName, name: "BOOTSTRAP_SECRET", configPath, dryRun: false }).catch(() => {});
    throw new Error(`bootstrap request to ${endpoint} failed: ${cause}`);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // ignore
  }

  // Whether or not bootstrap succeeded, close the door behind us.
  await deleteSecret({ workerName, name: "BOOTSTRAP_SECRET", configPath, dryRun: false }).catch((err) => {
    process.stderr.write(`provision-university: WARNING — failed to delete BOOTSTRAP_SECRET: ${err.message}\n`);
  });

  if (response.status === 409 && payload?.error?.code === "already_bootstrapped") {
    logSubstep(`super_admin already bootstrapped on the Worker — skipping`);
    return { skipped: true, password: null };
  }
  if (!response.ok) {
    const code = payload?.error?.code ?? "unknown";
    const msg = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`bootstrap failed: ${code}: ${msg}`);
  }

  logSubstep(`super_admin created (user_id=${payload?.data?.user?.id})`);
  return {
    skipped: false,
    password,
    passwordSource,
    user: payload?.data?.user,
    universityId: payload?.data?.university_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// summary report

function printSummary(report) {
  process.stdout.write("\n" + "-".repeat(72) + "\n");
  process.stdout.write("PROVISIONING SUMMARY\n");
  process.stdout.write("-".repeat(72) + "\n");
  for (const [k, v] of Object.entries(report)) {
    if (k === "tempPassword") continue;
    process.stdout.write(`  ${k.padEnd(22)} ${v ?? ""}\n`);
  }
  if (report.tempPassword) {
    process.stdout.write("\n  temp admin password   " + report.tempPassword + "\n");
    process.stdout.write("  ^ store this in a password manager and have the admin rotate it on first sign-in.\n");
  }
  process.stdout.write("-".repeat(72) + "\n");
}

// ---------------------------------------------------------------------------
// main

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage();

  const name = (args.name ?? "").trim();
  const slug = (args.slug ?? "").trim().toLowerCase();
  const adminEmail = (args["admin-email"] ?? "").trim().toLowerCase();
  const adminName = (args["admin-name"] ?? "").trim();
  const customDomain = (args["custom-domain"] ?? "").trim().toLowerCase() || null;
  const explicitAppBaseUrl = (args["app-base-url"] ?? "").trim() || null;
  const passwordEnvName = args["password-env"] ?? null;
  const skipBootstrap = Boolean(args["skip-bootstrap"]);
  const skipPagesDeploy = Boolean(args["skip-pages-deploy"]);
  const dryRun = Boolean(args["dry-run"]);

  const mailgun = {
    apiKey: args["mailgun-api-key"] ?? null,
    domain: args["mailgun-domain"] ?? null,
    fromEmail: args["mailgun-from-email"] ?? null,
    fromName: args["mailgun-from-name"] ?? null,
    region: args["mailgun-region"] ?? null,
  };
  const supportEmail = args["support-email"] ?? null;

  if (!name) usage("--name is required");
  const slugErr = validateSlug(slug);
  if (slugErr) usage(slugErr);
  if (!validateEmail(adminEmail)) usage("--admin-email must be a valid email address");
  if (!adminName) usage("--admin-name is required");

  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    usage("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be exported");
  }

  // Some Mailgun knobs only make sense in pairs. If any are present, require
  // the four primary ones — partial config silently breaks email sends.
  const mgKeys = ["apiKey", "domain", "fromEmail", "fromName"];
  const mgProvided = mgKeys.some((k) => mailgun[k]);
  if (mgProvided && !mgKeys.every((k) => mailgun[k])) {
    usage("when any Mailgun flag is supplied, --mailgun-api-key, --mailgun-domain, --mailgun-from-email, and --mailgun-from-name are all required");
  }

  process.stdout.write(`provision-university: ${slug} (${name})${dryRun ? " — DRY RUN" : ""}\n\n`);

  const workerName = `university-hub-${slug}`;
  const dbName = `university-hub-${slug}`;
  const pagesProjectName = `university-hub-${slug}-web`;

  // 1. workers.dev subdomain (needed to derive Worker URL).
  const workersSubdomain = await getWorkersSubdomain();
  if (!workersSubdomain) {
    throw new Error("could not resolve workers.dev subdomain for this account — set one in the Cloudflare dashboard");
  }
  const workerUrl = `https://${workerName}.${workersSubdomain}.workers.dev`;

  // 2. App base URL for emails. Custom domain wins; otherwise pages URL.
  const pagesUrl = `https://${pagesProjectName}.pages.dev`;
  const appBaseUrl = explicitAppBaseUrl
    ?? (customDomain ? `https://${customDomain}` : pagesUrl);

  // 3. Allowed origins. Always allow the canonical pages URL + the per-deploy
  //    preview wildcard. Add the custom domain too if set.
  const allowedOrigins = [
    pagesUrl,
    `https://*.${pagesProjectName}.pages.dev`,
  ];
  if (customDomain) allowedOrigins.push(`https://${customDomain}`);
  if (explicitAppBaseUrl) {
    try {
      const u = new URL(explicitAppBaseUrl);
      const origin = `${u.protocol}//${u.host}`;
      if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
    } catch {
      // Best-effort — bad --app-base-url surfaces below in the secret put.
    }
  }
  const allowedOriginsCsv = allowedOrigins.join(",");

  // 4. D1
  const d1 = await provisionD1(undefined, slug, dryRun);
  const dbId = d1.id === "<pending>" ? "00000000-0000-0000-0000-000000000000" : d1.id;

  // 5. Per-tenant wrangler.toml (committed to provisioning/<slug>/ — gitignored).
  await mkdir(PROVISIONING_DIR, { recursive: true });
  const tenantToml = renderWranglerToml({
    workerName,
    dbName,
    dbId,
    appBaseUrl,
    allowedOrigins: allowedOriginsCsv,
    migrationsDir: "../../migrations",
  });
  const configPath = await writeTenantConfig(slug, tenantToml);
  logStep(`Wrote tenant config: ${configPath}`);

  // 6. Apply non-seed migrations.
  if (!dryRun || d1.created === false) {
    await applyMigrations({ dbName, workerName, dryRun });
  } else {
    // In dry-run with a brand-new DB we can't apply migrations against
    // anything; just report what would happen.
    await applyMigrations({ dbName, workerName, dryRun: true });
  }

  // 7. Deploy the Worker.
  await deployWorker({ configPath, workerName, dryRun });

  // 8. Set runtime secrets.
  //
  // SESSION_SECRET is gated on first-run only: rotating it on a re-run
  // would invalidate every active session for the tenant, which is
  // exactly the kind of surprise an idempotent script must not deliver.
  // We treat "the D1 was just created" as the only signal that this is a
  // new tenant — Worker- or Pages-only pre-existence is rare, and an
  // operator who *wants* to rotate the secret can do it explicitly with
  // `wrangler secret put SESSION_SECRET --config=provisioning/<slug>/wrangler.toml`.
  //
  // The other secrets are not destructive on re-set: APP_BASE_URL,
  // ALLOWED_WEB_ORIGINS, and the Mailgun keys are pure overrides, and
  // operators frequently re-run to update one of them.
  logStep("Setting Worker secrets");
  if (d1.created) {
    const sessionSecret = generateRandomHex(32);
    await putSecret({ workerName, name: "SESSION_SECRET", value: sessionSecret, configPath, dryRun });
    logSubstep("SESSION_SECRET set (first run)");
  } else {
    logSubstep("SESSION_SECRET unchanged (re-run; existing tenant)");
  }
  // APP_BASE_URL and ALLOWED_WEB_ORIGINS are also declared in [vars]; the
  // secret form takes precedence and lets operators rotate without redeploying.
  await putSecret({ workerName, name: "APP_BASE_URL", value: appBaseUrl, configPath, dryRun });
  await putSecret({ workerName, name: "ALLOWED_WEB_ORIGINS", value: allowedOriginsCsv, configPath, dryRun });
  if (mgProvided) {
    await putSecret({ workerName, name: "MAILGUN_API_KEY", value: mailgun.apiKey, configPath, dryRun });
    await putSecret({ workerName, name: "MAILGUN_DOMAIN", value: mailgun.domain, configPath, dryRun });
    await putSecret({ workerName, name: "MAILGUN_FROM_EMAIL", value: mailgun.fromEmail, configPath, dryRun });
    await putSecret({ workerName, name: "MAILGUN_FROM_NAME", value: mailgun.fromName, configPath, dryRun });
    if (mailgun.region) {
      await putSecret({ workerName, name: "MAILGUN_REGION", value: mailgun.region, configPath, dryRun });
    }
    logSubstep("mailgun secrets set");
  } else {
    logSubstep("no Mailgun flags — leaving Mailgun unset (reuse SaaS-level Mailgun by setting these later, or use `wrangler secret put` from the per-tenant config)");
  }
  if (supportEmail) {
    await putSecret({ workerName, name: "SUPPORT_EMAIL", value: supportEmail, configPath, dryRun });
  }

  // 9. Pages project + deploy.
  const pages = await provisionPages({ slug, dryRun });
  const pagesDeployUrl = await buildAndDeployPages({
    projectName: pages.name,
    workerUrl,
    skipDeploy: skipPagesDeploy,
    dryRun,
  });

  // 10. Custom domain (Pages only — Worker custom domain is a follow-up
  //     because it needs a zone we may not own here. Documented in
  //     docs/per-customer-provisioning.md.)
  if (customDomain) {
    await attachPagesDomain({ projectName: pages.name, domain: customDomain, dryRun });
  }

  // 11. Bootstrap.
  let bootstrap = { skipped: true, password: null };
  if (skipBootstrap) {
    logStep("Bootstrap super_admin: skipped (--skip-bootstrap)");
  } else {
    bootstrap = await bootstrapAdmin({
      workerName,
      workerUrl,
      configPath,
      email: adminEmail,
      name: adminName,
      universityName: name,
      passwordEnvName,
      dryRun,
      dbName,
    });
  }

  // 12. Summary.
  const report = {
    slug,
    universityName: name,
    workerName,
    workerUrl,
    pagesProject: pages.name,
    pagesUrl: pagesDeployUrl ?? pagesUrl,
    customDomain: customDomain ?? "(none)",
    appBaseUrl,
    allowedOrigins: allowedOriginsCsv,
    d1: `${dbName} (${dbId})`,
    tenantConfig: configPath,
    bootstrap: bootstrap.skipped ? "skipped (existing super_admin)" : `${adminEmail} created`,
    tempPassword:
      bootstrap.password && bootstrap.passwordSource === "generated"
        ? bootstrap.password
        : null,
  };
  printSummary(report);

  if (customDomain) {
    process.stdout.write(
      [
        "",
        "DNS follow-up:",
        `  Add a CNAME for ${customDomain} pointing at ${pages.name}.pages.dev.`,
        "  Cloudflare will provision a certificate within a few minutes once DNS resolves.",
        "",
      ].join("\n"),
    );
  }
}

main().catch((err) => {
  process.stderr.write(`provision-university: ${err.message}\n`);
  if (process.env.PROVISION_DEBUG === "1" && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
