#!/usr/bin/env node
// check-web-bundle.mjs — UNI-46 postbuild gate.
//
// After `vite build` emits apps/web/dist/, this script verifies that the
// built JS chunk(s) actually contain the resolved VITE_API_BASE_URL. The
// Vite build-time plugin (vite.config.ts) refuses to start when the env
// is unset, but a defense-in-depth bundle scan also catches the case
// where the env was set but somehow not baked in (cache, plugin bug,
// future config drift). UNI-43 / UNI-46 was the operator-facing symptom
// of an empty bake.
//
// The expected origin is read the same way Vite resolves it: shell env
// first, then apps/web/.env.production, then apps/web/.env. Per-tenant
// deploys can override by exporting VITE_API_BASE_URL before
// `npm run build`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = resolve(REPO_ROOT, "apps/web");
const DIST_ASSETS = resolve(WEB_DIR, "dist/assets");
const ENV_FILES = [
  resolve(WEB_DIR, ".env.production.local"),
  resolve(WEB_DIR, ".env.local"),
  resolve(WEB_DIR, ".env.production"),
  resolve(WEB_DIR, ".env"),
];

function fail(msg) {
  process.stderr.write(`check-web-bundle: ${msg}\n`);
  process.exit(1);
}

function parseDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in out)) out[key] = value; // higher-precedence file wins
  }
  return out;
}

function resolveApiBaseUrl() {
  const fromShell = (process.env.VITE_API_BASE_URL ?? "").trim();
  if (fromShell) return fromShell;
  for (const envPath of ENV_FILES) {
    const parsed = parseDotenv(envPath);
    const v = (parsed.VITE_API_BASE_URL ?? "").trim();
    if (v) return v;
  }
  return "";
}

const expected = resolveApiBaseUrl();
if (!expected) {
  fail(
    "VITE_API_BASE_URL is not set in shell env nor in any tracked " +
      "apps/web/.env* file. The build-time plugin should have caught " +
      "this earlier — re-run `npm run build` to surface that error.",
  );
}

if (!existsSync(DIST_ASSETS)) {
  fail(
    `apps/web/dist/assets/ does not exist. Run \`npm run build\` first.`,
  );
}

const jsFiles = readdirSync(DIST_ASSETS)
  .filter((name) => name.endsWith(".js"))
  .map((name) => resolve(DIST_ASSETS, name));

if (jsFiles.length === 0) {
  fail("No .js chunks found under apps/web/dist/assets/.");
}

// Strip the protocol so `https://foo.workers.dev` and `http://foo.workers.dev`
// both match the host substring; the protocol is also baked verbatim, but
// matching the host is enough to confirm the env value reached the bundle.
const expectedUrl = (() => {
  try {
    return new URL(expected);
  } catch {
    fail(`Resolved VITE_API_BASE_URL is not a valid URL: ${expected}`);
    return null; // unreachable
  }
})();
const expectedHost = expectedUrl.host;

let foundIn = null;
for (const file of jsFiles) {
  const contents = readFileSync(file, "utf8");
  if (contents.includes(expectedHost)) {
    foundIn = file;
    break;
  }
}

if (!foundIn) {
  fail(
    `Expected origin ${JSON.stringify(expected)} (host ${expectedHost}) ` +
      `not found in any apps/web/dist/assets/*.js chunk. The bundle was ` +
      `built without baking in VITE_API_BASE_URL — Pages will serve a ` +
      `broken SPA. Re-run \`npm run build\` with the env set.`,
  );
}

// Surface a one-liner success so CI logs make it obvious the gate ran.
process.stdout.write(
  `check-web-bundle: OK — ${expectedHost} baked into ${foundIn.replace(REPO_ROOT + "/", "")}\n`,
);
