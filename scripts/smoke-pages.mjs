#!/usr/bin/env node
// smoke-pages.mjs — UNI-46 post-deploy Pages smoke.
//
// Hits a deployed (preview or production) Cloudflare Pages URL and
// asserts that the SPA bundle was built with VITE_API_BASE_URL pointed
// at a real Worker origin. Catches the UNI-46 regression — Pages
// shipping a bundle whose `b1=""` makes /api/auth/sign-in POST to the
// Pages host, which returns 405 Method Not Allowed.
//
// Usage:
//   node scripts/smoke-pages.mjs                                     # default tenant
//   node scripts/smoke-pages.mjs --pages-url=https://<sha>.<proj>.pages.dev
//   node scripts/smoke-pages.mjs --pages-url=... --worker-url=https://...workers.dev
//
// Defaults — derived from the committed `apps/web/.env.production` and
// the wrangler `name` so a fresh checkout's smoke just works:
//   pages-url:  https://university-hub-v2-web.pages.dev
//   worker-url: value of VITE_API_BASE_URL in apps/web/.env.production
//
// Exit code 0 on green, 1 on any failure. Designed to be the last step
// of a deploy script (`wrangler pages deploy ... && node scripts/smoke-pages.mjs`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  process.stderr.write(`smoke-pages: FAIL — ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`smoke-pages: ok — ${msg}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-z][a-z0-9-]*)=(.*)$/);
    if (!m) fail(`unrecognised arg: ${raw}`);
    out[m[1]] = m[2];
  }
  return out;
}

function readDotenv(path) {
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
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv);
const pagesUrl = (args["pages-url"] ?? "https://university-hub-v2-web.pages.dev")
  .replace(/\/+$/, "");
const envFile = readDotenv(resolve(REPO_ROOT, "apps/web/.env.production"));
const workerUrl = (
  args["worker-url"] ??
  process.env.VITE_API_BASE_URL ??
  envFile.VITE_API_BASE_URL ??
  ""
).trim().replace(/\/+$/, "");

if (!workerUrl) {
  fail(
    "no Worker origin to assert against. Pass --worker-url=... or " +
      "set VITE_API_BASE_URL or commit apps/web/.env.production.",
  );
}

const workerHost = (() => {
  try {
    return new URL(workerUrl).host;
  } catch {
    fail(`--worker-url is not a valid URL: ${workerUrl}`);
    return null;
  }
})();

ok(`pages=${pagesUrl}  worker=${workerUrl}`);

// 1. Fetch the SPA root and find the asset URL of the index chunk.
const rootRes = await fetch(pagesUrl + "/", { redirect: "follow" });
if (!rootRes.ok) {
  fail(`GET ${pagesUrl}/ returned ${rootRes.status}`);
}
const rootHtml = await rootRes.text();
const scriptMatch = rootHtml.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!scriptMatch) {
  fail(
    `could not find /assets/index-*.js in the Pages root HTML. The site may be down or the SPA shell changed.`,
  );
}
const bundleUrl = pagesUrl + scriptMatch[1];
ok(`bundle = ${bundleUrl}`);

// 2. Download the bundle and assert the worker host is baked in.
const bundleRes = await fetch(bundleUrl);
if (!bundleRes.ok) {
  fail(`GET ${bundleUrl} returned ${bundleRes.status}`);
}
const bundle = await bundleRes.text();
if (!bundle.includes(workerHost)) {
  fail(
    `bundle does not contain ${workerHost}. The Pages deploy was built ` +
      `with an empty or wrong VITE_API_BASE_URL — sign-in will return ` +
      `405 from the Pages origin (UNI-46 regression).`,
  );
}
ok(`bundle contains worker host ${workerHost}`);

// 3. Confirm the Worker is reachable and CORS-allows the Pages origin.
const sentinelPath = "/api/__smoke__/should-not-exist-" + Date.now();
const preflight = await fetch(workerUrl + sentinelPath, {
  method: "OPTIONS",
  headers: {
    Origin: pagesUrl,
    "Access-Control-Request-Method": "POST",
  },
});
const allowOrigin = preflight.headers.get("access-control-allow-origin") ?? "";
if (preflight.status >= 400) {
  fail(`OPTIONS ${workerUrl}${sentinelPath} returned ${preflight.status}`);
}
if (allowOrigin !== pagesUrl) {
  fail(
    `Worker did not allow Pages origin ${pagesUrl} on preflight (got ` +
      `Access-Control-Allow-Origin=${JSON.stringify(allowOrigin)}). ` +
      `Add ${pagesUrl} to ALLOWED_WEB_ORIGINS on the Worker.`,
  );
}
ok(`worker preflight allows ${pagesUrl}`);

// 4. Confirm the Pages origin itself rejects POST /api/* — this is the
// exact UNI-46 symptom; if the SPA ever falls back to relative paths,
// this is what the user sees. Asserting it stays a 405 (rather than,
// say, a misconfigured proxy that quietly returns HTML) makes the
// failure mode predictable.
const pagesPost = await fetch(pagesUrl + "/api/auth/sign-in", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (pagesPost.status !== 405) {
  // Not a hard fail: the Pages config could legitimately add a proxy
  // someday. Just print so QA notices.
  process.stdout.write(
    `smoke-pages: NOTE — POST ${pagesUrl}/api/auth/sign-in returned ${pagesPost.status} ` +
      `(expected 405 from Pages with no /api/* proxy)\n`,
  );
} else {
  ok(`pages POST /api/auth/sign-in → 405 (as expected; SPA must call worker directly)`);
}

ok("all checks passed");
