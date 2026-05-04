#!/usr/bin/env node
// audit-gate.mjs — UNI-29 npm audit CI gate.
//
// Wraps `npm audit --json` and fails the build on any high or critical
// vulnerability that has not been explicitly suppressed in `.audit-ignore`
// at the repo root.
//
// .audit-ignore format:
//   - Lines starting with `#` are comments.
//   - Blank lines are ignored.
//   - Each non-comment line is a single advisory identifier — either the
//     GitHub advisory id (e.g. `GHSA-xxxx-yyyy-zzzz`) or a CVE id
//     (e.g. `CVE-2024-12345`). Anything else is rejected.
//   - Every ignored id MUST be preceded by at least one comment line giving
//     the justification (vendor patch pending, false positive, …). The
//     gate refuses to run if a bare id has no justification above it.
//
// Triage flow lives in docs/security-ci.md.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_IGNORE_PATH = resolve(REPO_ROOT, ".audit-ignore");
const FAIL_LEVELS = new Set(["high", "critical"]);
const ID_PATTERN = /^(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,})$/i;

function fail(msg) {
  process.stderr.write(`audit-gate: ${msg}\n`);
  process.exit(1);
}

function loadIgnoreList() {
  if (!existsSync(AUDIT_IGNORE_PATH)) return new Set();
  const lines = readFileSync(AUDIT_IGNORE_PATH, "utf8").split(/\r?\n/);
  const ignored = new Set();
  let sawComment = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") {
      sawComment = false;
      continue;
    }
    if (line.startsWith("#")) {
      sawComment = true;
      continue;
    }
    if (!ID_PATTERN.test(line)) {
      fail(`.audit-ignore line ${i + 1}: "${line}" is not a valid advisory id (expected GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN)`);
    }
    if (!sawComment) {
      fail(`.audit-ignore line ${i + 1}: ${line} has no justification — add a "# ..." comment line above the id explaining why it is suppressed`);
    }
    ignored.add(line.toUpperCase());
    sawComment = false;
  }
  return ignored;
}

function runAudit() {
  // `npm audit --json` exits non-zero when vulnerabilities are present. We
  // care about its JSON payload, not its exit code — the gate decides.
  const result = spawnSync(
    "npm",
    ["audit", "--json", "--audit-level=high", "--workspaces", "--include-workspace-root"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) fail(`failed to spawn npm: ${result.error.message}`);
  if (!result.stdout) {
    fail(`npm audit produced no stdout (stderr: ${result.stderr || "<empty>"})`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse npm audit JSON: ${err.message}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  if (report.error) {
    fail(`npm audit reported an error: ${report.error.summary || JSON.stringify(report.error)}`);
  }
  return report;
}

// Collects {advisory_id, package, severity, url} for every high/critical
// finding. npm 7+ reports vulnerabilities keyed by package, with each entry
// holding a `via` array of either advisory objects or string package names
// (transitive). We only want the advisory objects.
function collectFindings(report) {
  const findings = [];
  const vulns = report.vulnerabilities || {};
  for (const [pkg, entry] of Object.entries(vulns)) {
    if (!entry) continue;
    const via = Array.isArray(entry.via) ? entry.via : [];
    for (const v of via) {
      // Object entries are the actual advisory records. String entries are
      // transitive package-name pointers — skip those; the same advisory
      // surfaces directly under the package that defines it.
      if (typeof v !== "object" || v === null) continue;
      if (!FAIL_LEVELS.has(v.severity)) continue;
      // Pull GHSA / CVE ids out of the url and the title.
      const haystack = `${v.url || ""} ${v.title || ""}`;
      const matches =
        haystack.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,}/gi) || [];
      const ids = [...new Set(matches.map((m) => m.toUpperCase()))];
      findings.push({
        package: pkg,
        severity: v.severity,
        title: v.title || "(no title)",
        url: v.url || "",
        ids,
      });
    }
  }
  return findings;
}

function main() {
  const ignored = loadIgnoreList();
  const report = runAudit();
  const findings = collectFindings(report);

  const blocking = [];
  const suppressed = [];
  for (const f of findings) {
    const matched = f.ids.find((id) => ignored.has(id));
    if (matched) suppressed.push({ ...f, matched });
    else blocking.push(f);
  }

  const summarize = (f) =>
    `  - [${f.severity.toUpperCase()}] ${f.package}: ${f.title}` +
    (f.ids.length ? ` (${f.ids.join(", ")})` : "") +
    (f.url ? `\n    ${f.url}` : "");

  if (suppressed.length) {
    process.stdout.write(`audit-gate: ${suppressed.length} suppressed finding(s) (.audit-ignore):\n`);
    for (const f of suppressed) process.stdout.write(`${summarize(f)}\n    suppressed by: ${f.matched}\n`);
  }

  if (blocking.length === 0) {
    process.stdout.write(`audit-gate: no blocking high/critical advisories. ${suppressed.length} suppressed.\n`);
    process.exit(0);
  }

  process.stderr.write(`audit-gate: ${blocking.length} blocking high/critical advisory(ies):\n`);
  for (const f of blocking) process.stderr.write(`${summarize(f)}\n`);
  process.stderr.write(
    `\nResolve by upgrading the affected package, replacing it, or — if upgrading is impossible right now — adding a justified entry to .audit-ignore. See docs/security-ci.md for the triage flow.\n`,
  );
  process.exit(1);
}

main();
