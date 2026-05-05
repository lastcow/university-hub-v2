#!/usr/bin/env node
// license-check.mjs — UNI-29 license-compatibility CI gate.
//
// Wraps `license-checker-rseidelsohn` (a maintained fork of `license-checker`
// kept only for CI; not added as a runtime dep) and fails when any installed
// dependency reports a license outside the workspace allowlist.
//
// Scope: scans the full installed `node_modules/` tree of the workspace.
// We deliberately do NOT pass `--production` — `--production` from the
// monorepo root with npm workspaces returns an empty result, and treating
// devDependency licenses as ignorable makes the gate dishonest. License
// risk applies to anything we install, not only what ships.
//
// Allowlist: MIT, Apache-2.0, BSD (all variants), ISC, Unlicense, plus a
// small set of permissive equivalents (CC0-1.0, CC-BY-4.0 for data
// packages, 0BSD, WTFPL, Python-2.0). Full canonical list + rationale
// lives in docs/security-ci.md.
//
// Notes for future-you:
//   - Workspace-internal packages (the ones declared in package.json
//     `workspaces`) are excluded; they are the project's own code.
//   - Packages whose license is reported as `UNKNOWN` are blocked — we
//     cannot verify compliance, which is the same risk class as a hostile
//     license.
//   - SPDX expressions: `A OR B` is allowed if any token is allowed (we
//     can pick the permissive option). `A AND B` requires every token to
//     be allowed. Mixed expressions are conservatively rejected.
//   - Scoped exceptions: a small set of named packages may carry a license
//     not on the global allowlist. Each entry pins both the exact package
//     name and the exact reported license string — if either drifts, the
//     gate fails again so the exception can be re-justified. Rationale
//     for each entry lives in docs/security-ci.md §4 ("Scoped exceptions").
//     This is NOT a knob for adding broad license families to the
//     allowlist quietly.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each entry is matched case-insensitively against the license string
// reported by license-checker, which may be a single SPDX id, a parenthesized
// SPDX expression like "(MIT OR Apache-2.0)", or a comma-separated list.
const ALLOWED = new Set(
  [
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "Apache 2.0",
    "Apache",
    "BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD-3-Clause-Clear",
    "0BSD",
    "ISC",
    "Unlicense",
    "WTFPL",
    "CC0-1.0",
    "CC-BY-4.0",
    "Python-2.0",
  ].map((s) => s.toLowerCase()),
);

// Scoped per-package exceptions. Keyed by the bare package name (no
// version) reported by license-checker (which formats keys as
// `name@version`). The value pins the exact license string we expect to
// see — if upstream changes the license, the exception stops applying
// and the gate fails again so the exception can be re-evaluated.
//
// Adding an entry here requires engineering-lead approval and a matching
// row in docs/security-ci.md §4 "Scoped exceptions" with the rationale,
// dependency path, and reassessment date.
const SCOPED_EXCEPTIONS = new Map([
  [
    "@img/sharp-libvips-linux-x64",
    {
      license: "LGPL-3.0-or-later",
      reason:
        "Precompiled libvips native binary, dev-only via wrangler→miniflare→sharp. Not bundled into the Worker; LGPL dynamic-link terms are satisfied by the upstream package shipping its own LICENSE/NOTICE.",
    },
  ],
  [
    "@img/sharp-libvips-linuxmusl-x64",
    {
      license: "LGPL-3.0-or-later",
      reason:
        "Precompiled libvips native binary, dev-only via wrangler→miniflare→sharp. Not bundled into the Worker; LGPL dynamic-link terms are satisfied by the upstream package shipping its own LICENSE/NOTICE.",
    },
  ],
]);

// Strip the trailing `@<version>` from a license-checker key like
// `@img/sharp-libvips-linux-x64@1.2.4` → `@img/sharp-libvips-linux-x64`.
// Scoped names start with `@` and contain a second `@` for the version.
function packageNameOf(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return key;
  return key.slice(0, at);
}

// Returns the exception entry if `key` is on the scoped exception list
// AND the reported license matches the pinned value, otherwise null.
function scopedExceptionFor(key, license) {
  const name = packageNameOf(key);
  const entry = SCOPED_EXCEPTIONS.get(name);
  if (!entry) return null;
  if (String(license).trim() !== entry.license) return null;
  return { name, ...entry };
}

// Internal workspace packages — derived from the root package.json so this
// stays in sync with `npm workspaces` automatically.
function workspacePackageNames() {
  const root = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const names = [root.name];
  for (const dir of root.workspaces || []) {
    // Each entry is either a literal path or a glob like "apps/*".
    if (!dir.endsWith("/*")) {
      names.push(readPackageName(resolve(REPO_ROOT, dir)));
      continue;
    }
    const parent = resolve(REPO_ROOT, dir.replace(/\/\*$/, ""));
    for (const child of readdirSync(parent)) {
      const full = resolve(parent, child);
      if (!statSync(full).isDirectory()) continue;
      const name = readPackageName(full);
      if (name) names.push(name);
    }
  }
  return names.filter(Boolean);
}

function readPackageName(dir) {
  try {
    return JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).name;
  } catch {
    return null;
  }
}

function fail(msg) {
  process.stderr.write(`license-check: ${msg}\n`);
  process.exit(1);
}

// license-checker reports license strings that may combine SPDX ids.
// Treat the entry as compliant only if EVERY token resolves to an allowed
// id — `(MIT OR GPL-3.0)` is flexible enough that "OR" is permissive (you
// can choose MIT) but `(MIT AND GPL-3.0)` is not. Conservative: require
// all tokens allowed unless the expression is a clean OR of allowed ids.
function isAllowed(license) {
  if (!license) return false;
  const raw = String(license).trim();
  if (!raw || raw.toUpperCase() === "UNKNOWN") return false;
  // Split on the conjunction-aware delimiters.
  const cleaned = raw.replace(/^\(|\)$/g, "").trim();
  // Detect AND vs OR. Mixed (rare) is rejected for safety.
  const hasAnd = /\sAND\s/i.test(cleaned);
  const hasOr = /\sOR\s/i.test(cleaned);
  if (hasAnd && hasOr) return false;
  const tokens = cleaned
    .split(/\s+(?:AND|OR)\s+|,\s*/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (hasOr) return tokens.some((t) => ALLOWED.has(t.toLowerCase()));
  return tokens.every((t) => ALLOWED.has(t.toLowerCase()));
}

function runCheck() {
  const internal = workspacePackageNames();
  const args = [
    "--yes",
    "license-checker-rseidelsohn@4.4.2",
    "--json",
    "--start",
    REPO_ROOT,
  ];
  if (internal.length) {
    args.push("--excludePackages", internal.join(";"));
  }
  const result = spawnSync("npx", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`failed to spawn npx: ${result.error.message}`);
  if (result.status !== 0 && !result.stdout) {
    fail(`license-checker failed (exit ${result.status}): ${result.stderr || "<no stderr>"}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse license-checker JSON: ${err.message}\n--- stdout (first 4kb) ---\n${result.stdout.slice(0, 4096)}\n--- stderr ---\n${result.stderr}`);
  }
  return report;
}

function main() {
  const report = runCheck();
  const blocking = [];
  const exceptions = [];
  let allowed = 0;
  for (const [pkg, info] of Object.entries(report)) {
    if (isAllowed(info.licenses)) {
      allowed++;
      continue;
    }
    const exception = scopedExceptionFor(pkg, info.licenses);
    if (exception) {
      exceptions.push({ pkg, license: info.licenses });
      continue;
    }
    blocking.push({ pkg, license: info.licenses, repository: info.repository || "" });
  }
  if (blocking.length === 0) {
    let summary = `license-check: ${allowed} package(s) verified against allowlist.`;
    if (exceptions.length) {
      summary += ` ${exceptions.length} scoped exception(s) accepted:`;
      process.stdout.write(`${summary}\n`);
      for (const e of exceptions) {
        process.stdout.write(`  - ${e.pkg}: ${JSON.stringify(e.license)} (see docs/security-ci.md §4 "Scoped exceptions")\n`);
      }
    } else {
      process.stdout.write(`${summary} No findings.\n`);
    }
    process.exit(0);
  }
  process.stderr.write(`license-check: ${blocking.length} package(s) reported an unapproved license:\n`);
  for (const f of blocking) {
    process.stderr.write(`  - ${f.pkg}: ${JSON.stringify(f.license)}${f.repository ? `\n      ${f.repository}` : ""}\n`);
  }
  process.stderr.write(
    `\nAllowlist: MIT / Apache-2.0 / BSD-* / ISC / Unlicense (full SPDX list in scripts/license-check.mjs).\nResolve by removing the dependency, replacing it, or — only with engineering-lead approval — extending the allowlist in scripts/license-check.mjs (or, for a single package, the SCOPED_EXCEPTIONS map) and documenting the exception in docs/security-ci.md.\n`,
  );
  process.exit(1);
}

main();
