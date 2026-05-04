#!/usr/bin/env node
// Sync the canonical Mailgun templates from `mailgun_templates/` to the
// configured Mailgun account (epic UNI-1 §13, sub-issue UNI-20). Run from
// the repo root via `npm run sync:mailgun-templates`.
//
// Behaviour:
//   - For each subdirectory of `mailgun_templates/`:
//     - If no Mailgun template exists with that name → create it (POST
//       /v3/<domain>/templates) with our HTML as the initial active version.
//     - If a template exists → compare our local HTML against the active
//       version's body. Identical ⇒ "unchanged", no further API call.
//       Different ⇒ POST a new version (POST /v3/<domain>/templates/<name>/versions)
//       tagged with a short hash of the new body and marked active.
//   - Prints a final summary table (created / updated / unchanged / failed).
//   - Exits 0 only when every template synced successfully.
//
// Env vars (loaded from process.env first, then `apps/worker/.dev.vars` as
// a convenience for local dev):
//   - MAILGUN_API_KEY    required
//   - MAILGUN_DOMAIN     required
//   - MAILGUN_REGION     optional, defaults to US (EU flips the API base)
//
// The script never logs the API key. Network errors and non-2xx responses
// surface a sanitized message and a non-zero exit.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "mailgun_templates");
const DEV_VARS_PATH = resolve(REPO_ROOT, "apps/worker/.dev.vars");

// ---------------------------------------------------------------------------
// env

async function loadDevVars(path) {
  try {
    await stat(path);
  } catch {
    return {};
  }
  const raw = await readFile(path, "utf8");
  const out = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
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

function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim();
  if (v.length === 0) return true;
  return v.toLowerCase().startsWith("replace-with-");
}

function mailgunBaseUrl(region) {
  if ((region ?? "").trim().toUpperCase() === "EU") {
    return "https://api.eu.mailgun.net";
  }
  return "https://api.mailgun.net";
}

async function readEnv() {
  const fileEnv = await loadDevVars(DEV_VARS_PATH);
  const get = (key) => process.env[key] ?? fileEnv[key];
  const apiKey = get("MAILGUN_API_KEY");
  const domain = get("MAILGUN_DOMAIN");
  const region = get("MAILGUN_REGION");
  if (isPlaceholder(apiKey)) {
    throw new Error(
      "MAILGUN_API_KEY is missing or set to a placeholder. Export it in your shell or set it in apps/worker/.dev.vars.",
    );
  }
  if (isPlaceholder(domain)) {
    throw new Error(
      "MAILGUN_DOMAIN is missing or set to a placeholder. Export it in your shell or set it in apps/worker/.dev.vars.",
    );
  }
  return {
    apiKey: apiKey.trim(),
    domain: domain.trim(),
    region: (region ?? "US").trim().toUpperCase(),
    baseUrl: mailgunBaseUrl(region),
  };
}

// ---------------------------------------------------------------------------
// local templates

async function loadLocalTemplates() {
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(TEMPLATES_DIR, entry.name);
    const htmlPath = join(dir, "index.html");
    const metaPath = join(dir, "meta.json");
    let html;
    try {
      html = await readFile(htmlPath, "utf8");
    } catch {
      console.warn(`[skip] ${entry.name}: missing index.html`);
      continue;
    }
    let meta = { description: "", tags: [], engine: "handlebars" };
    try {
      const raw = await readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw);
      meta = {
        description: typeof parsed.description === "string" ? parsed.description : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string") : [],
        engine: typeof parsed.engine === "string" && parsed.engine.length > 0
          ? parsed.engine
          : "handlebars",
      };
    } catch {
      // no meta.json — fall back to defaults
    }
    templates.push({
      name: entry.name,
      html,
      description: meta.description,
      tags: meta.tags,
      engine: meta.engine,
    });
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

// ---------------------------------------------------------------------------
// Mailgun client

function authHeader(apiKey) {
  return `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;
}

function shortHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

async function mailgunRequest({ baseUrl, apiKey }, method, path, body) {
  const url = `${baseUrl}${path}`;
  const init = {
    method,
    headers: {
      Authorization: authHeader(apiKey),
      Accept: "application/json",
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = body.toString();
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "fetch_failed";
    throw new Error(`network error calling ${method} ${path}: ${detail}`);
  }
  let payload = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 200) };
    }
  }
  return { status: response.status, ok: response.ok, payload };
}

async function getTemplate(cfg, name) {
  const { status, ok, payload } = await mailgunRequest(
    cfg,
    "GET",
    `/v3/${encodeURIComponent(cfg.domain)}/templates/${encodeURIComponent(name)}?active=yes`,
  );
  if (status === 404) return null;
  if (!ok) {
    throw new Error(
      `Mailgun GET template "${name}" failed: HTTP ${status} ${payload?.message ?? ""}`.trim(),
    );
  }
  // Mailgun shape: { template: { name, description, version: { tag, template, engine, active, ... } } }
  return payload?.template ?? null;
}

async function createTemplate(cfg, tpl) {
  const body = new URLSearchParams();
  body.set("name", tpl.name);
  if (tpl.description) body.set("description", tpl.description);
  body.set("template", tpl.html);
  body.set("engine", tpl.engine);
  body.set("tag", `v-${shortHash(tpl.html)}`);
  body.set("comment", "Initial version (sync-mailgun-templates)");
  if (tpl.tags.length > 0) body.set("h:X-Mailgun-Tag", tpl.tags.join(","));
  const { ok, status, payload } = await mailgunRequest(
    cfg,
    "POST",
    `/v3/${encodeURIComponent(cfg.domain)}/templates`,
    body,
  );
  if (!ok) {
    throw new Error(
      `Mailgun POST template "${tpl.name}" failed: HTTP ${status} ${payload?.message ?? ""}`.trim(),
    );
  }
  return payload;
}

async function uploadNewVersion(cfg, tpl) {
  const body = new URLSearchParams();
  body.set("template", tpl.html);
  body.set("engine", tpl.engine);
  body.set("tag", `v-${shortHash(tpl.html)}`);
  body.set("active", "yes");
  body.set("comment", "Sync from mailgun_templates/");
  const { ok, status, payload } = await mailgunRequest(
    cfg,
    "POST",
    `/v3/${encodeURIComponent(cfg.domain)}/templates/${encodeURIComponent(tpl.name)}/versions`,
    body,
  );
  if (!ok) {
    // If a version with the same tag already exists Mailgun returns 400.
    // That implies "this exact body was already uploaded under this tag" —
    // safe to treat as unchanged.
    if (status === 400 && /exist/i.test(payload?.message ?? "")) {
      return { alreadyExisted: true };
    }
    throw new Error(
      `Mailgun POST version for "${tpl.name}" failed: HTTP ${status} ${payload?.message ?? ""}`.trim(),
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// orchestration

function compareBodies(remoteBody, localBody) {
  // Mailgun preserves bodies byte-for-byte; a strict equality check is
  // sufficient. Some accounts strip a trailing newline — guard against that.
  if (remoteBody === localBody) return true;
  const trim = (s) => (typeof s === "string" ? s.replace(/\s+$/, "") : "");
  return trim(remoteBody) === trim(localBody);
}

async function syncOne(cfg, tpl) {
  const existing = await getTemplate(cfg, tpl.name);
  if (!existing) {
    await createTemplate(cfg, tpl);
    return { name: tpl.name, action: "created" };
  }
  const activeBody = existing?.version?.template;
  if (typeof activeBody === "string" && compareBodies(activeBody, tpl.html)) {
    return { name: tpl.name, action: "unchanged" };
  }
  const result = await uploadNewVersion(cfg, tpl);
  if (result?.alreadyExisted) {
    return { name: tpl.name, action: "unchanged" };
  }
  return { name: tpl.name, action: "updated" };
}

function printSummary(results) {
  const widthName = Math.max(8, ...results.map((r) => r.name.length));
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  console.log("");
  console.log(`${pad("template", widthName)}  result`);
  console.log(`${"-".repeat(widthName)}  ${"-".repeat(10)}`);
  for (const r of results) {
    const note = r.action === "failed" ? `failed: ${r.error}` : r.action;
    console.log(`${pad(r.name, widthName)}  ${note}`);
  }
  const counts = results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const summary = ["created", "updated", "unchanged", "failed"]
    .map((k) => `${counts[k] ?? 0} ${k}`)
    .join(", ");
  console.log("");
  console.log(`Done: ${summary}.`);
}

async function main() {
  const cfg = await readEnv();
  const templates = await loadLocalTemplates();
  if (templates.length === 0) {
    console.error(`No templates found under ${TEMPLATES_DIR}.`);
    process.exit(1);
  }
  console.log(
    `Syncing ${templates.length} template(s) to Mailgun domain "${cfg.domain}" (${cfg.region}) ...`,
  );
  const results = [];
  for (const tpl of templates) {
    try {
      const result = await syncOne(cfg, tpl);
      results.push(result);
      console.log(`  ${result.action}: ${result.name}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      results.push({ name: tpl.name, action: "failed", error: message });
      console.log(`  failed: ${tpl.name} — ${message}`);
    }
  }
  printSummary(results);
  const anyFailed = results.some((r) => r.action === "failed");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`sync-mailgun-templates: ${message}`);
  process.exit(1);
});
