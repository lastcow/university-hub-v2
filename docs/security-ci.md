# Security CI gates (UNI-29)

This document is the operator handbook for the automated security gates
that run on every PR and push to `main`. The goal is to catch
known-vulnerable dependencies, obvious code-smell vulnerabilities, secret
leaks, and license incompatibilities **before** they hit a real-student
deployment.

There are five gates plus one supporting hook:

| Gate | Where it runs | What it does | Where to look at findings |
|---|---|---|---|
| **Dependabot** | GitHub-hosted | Opens PRs upgrading dependencies on a weekly cadence; opens security PRs immediately for new advisories. | Pull requests labeled `dependencies`. |
| **npm audit gate** | `.github/workflows/security-audit.yml` | Fails CI on any unsuppressed high/critical advisory in the dependency tree. | The job's logs; suppressions in `.audit-ignore`. |
| **CodeQL** | `.github/workflows/codeql.yml` | Runs the GitHub `security-and-quality` query suite for JavaScript/TypeScript. | Repo → Security → Code scanning. |
| **License check** | `.github/workflows/license-check.yml` | Fails CI on any production dependency whose license is not on the allowlist. | The job's logs. |
| **Secret scanning (server)** | GitHub-built-in | Catches leaked credentials post-push. | Repo → Security → Secret scanning. |
| **Secret scanning (pre-commit)** | `scripts/git-hooks/pre-commit` | Local defense-in-depth — refuses to commit if a known secret pattern appears in the staged diff. | Hook output in your terminal. |

---

## 1. Dependabot

Configured in [.github/dependabot.yml](../.github/dependabot.yml). One npm
ecosystem entry per `package.json` (root, `apps/web`, `apps/worker`,
`packages/shared`) plus a `github-actions` entry. Schedule: weekly,
Mondays 06:00 UTC. Security advisories open PRs immediately regardless of
the cadence.

### Triage flow

1. Dependabot opens a PR labeled `dependencies`.
2. CI runs the full PR pipeline against the upgrade — including the
   `security-audit` and `license-check` gates below. If any of them fail,
   investigate before merging (the upgrade may itself introduce a worse
   problem).
3. Merge if green and the changelog has no breaking changes that affect
   us. Squash-merge to keep history clean.
4. If a major upgrade is breaking, close the PR with a comment linking
   the tracking issue and re-pin the version range in the relevant
   `package.json` so Dependabot stops reopening it.

### Repo settings to verify on initial activation

The workflow file alone does not enable Dependabot — the repo owner has
to confirm it under **Settings → Code security and analysis**:

- **Dependency graph**: on (free for all repos).
- **Dependabot alerts**: on.
- **Dependabot security updates**: on.

These are one-time toggles. Once on, the `.github/dependabot.yml` schedule
takes over.

---

## 2. npm audit gate

Runs `node scripts/audit-gate.mjs` on every PR, push to `main`, and
nightly at 03:30 UTC. The script wraps `npm audit --audit-level=high
--workspaces --include-workspace-root` and fails the build on any
**high** or **critical** severity advisory.

### Suppression — `.audit-ignore`

When an advisory cannot be fixed right now (no upstream patch, false
positive, dev-only path that is not reachable from production code), add
the advisory id to `.audit-ignore` at the repo root. Format:

```
# YYYY-MM-DD — short justification. Link the tracking issue if you
# expect to revisit this. Reassess by YYYY-MM-DD.
GHSA-xxxx-xxxx-xxxx
```

Rules enforced by the gate:

- Each id must be a `GHSA-xxxx-xxxx-xxxx` or `CVE-YYYY-NNNN`.
- Each id **must** be preceded by at least one comment line giving the
  justification. The gate fails if it sees a bare id.
- A blank line resets the "preceding comment" state, so each suppression
  is self-contained.

A suppression is technical debt. Re-evaluate every entry at least
quarterly — if the upstream still has not fixed it, the team should
decide whether the dependency stays.

### Currently suppressed (carry-over from initial gate activation)

The following advisories were active in the dev-tool dependency closure
when the gate was first wired up. All five live entirely in dev / build /
deploy tooling — none ship in the production Worker bundle. They are
suppressed pending a coordinated dev-tooling refresh; reassess by
**2026-08-01**.

| GHSA | Package | Why suppressed |
|---|---|---|
| `GHSA-9crc-q9x8-hgqq` | vitest | Test runner. RCE only via Vitest API server in dev. |
| `GHSA-36p8-mvp6-cv38` | wrangler | Deploy tool. OS command injection requires attacker-controlled flag values. |
| `GHSA-p9ff-h696-f583` | vite | Dev server only. Static SPA build does not include vite. |
| `GHSA-vrm6-8vpv-qv8q` | undici | Transitive of wrangler/miniflare. Dev/deploy only. |
| `GHSA-v9p9-hfj2-hcw8` | undici | Same as above. |

### Triage flow

1. Gate fails on PR.
2. Read the failure: it lists the package, severity, advisory id, and a
   link to the GHSA/CVE.
3. **First attempt**: bump the package. `npm update <pkg>` for a minor /
   patch bump, or open a Dependabot-style PR for a major bump. Re-run
   the gate locally with `npm run audit:gate`.
4. If the fix lives in a transitive dependency, use
   `npm audit fix` (or `npm audit fix --force` only after reading the
   diff). Then re-run.
5. **If no fix exists**: add a justified entry to `.audit-ignore` and
   open a tracking issue.
6. **If the advisory is a false positive** (e.g. only triggered through
   a code path we don't use): suppress with a justification that says
   so explicitly. Document the reasoning in the tracking issue.

### Local verification

```bash
npm ci
npm run audit:gate
```

The script exits 0 with a one-line summary on green, exit 1 with a
per-finding list on red.

---

## 3. CodeQL

Runs the GitHub `javascript-typescript` analyzer with the
`security-and-quality` query suite on every PR, every push to `main`,
and weekly on Monday 04:00 UTC (catches new queries published since the
last code change).

Findings appear under **Repo → Security → Code scanning**. Each finding
has a severity, a remediation suggestion, and a link to the relevant
CWE / Common Weakness Enumeration entry.

### Triage flow

1. PR shows a CodeQL finding.
2. Open the alert. Read the data flow CodeQL traced.
3. **If actionable**: fix the code, push, alert auto-resolves.
4. **If false positive**: dismiss with one of the standard reasons
   (`false positive`, `won't fix`, `used in tests`). Dismissals are
   audit-logged; pick the reason that's actually true.
5. **If acceptable risk**: do not silently dismiss. Open a tracking
   issue, dismiss with a justification that links the issue, decide a
   reassessment date.

CodeQL alerts on `main` are visible to anyone with write access. Treat
them like any other security backlog item.

---

## 4. License compatibility check

Runs `node scripts/license-check.mjs` on every PR and push that touches a
`package.json`, the lockfile, or the script itself. The script wraps
`license-checker-rseidelsohn` against the full installed `node_modules/`
tree of the workspace and fails on any package whose license is not on
the allowlist.

> **Note:** earlier drafts ran `license-checker --production` to scope to
> shipped code only. With npm workspaces that returns an empty result
> from the monorepo root, and devDependency licenses are not actually
> ignorable risk (they affect every contributor's checkout). The gate
> therefore audits the entire installed tree, with workspace-internal
> packages excluded.

### Allowed licenses

The canonical list lives in `scripts/license-check.mjs`. Today it is:

| SPDX id | Family | Notes |
|---|---|---|
| `MIT`, `MIT-0` | MIT | Permissive, attribution required (MIT-0 waives even attribution). |
| `Apache-2.0` | Apache | Permissive, attribution + patent grant. |
| `BSD`, `BSD-2-Clause`, `BSD-3-Clause`, `BSD-3-Clause-Clear`, `0BSD` | BSD | Permissive. |
| `ISC` | ISC | Permissive, MIT-equivalent. |
| `Unlicense` | Public domain dedication | OK. |
| `WTFPL` | Permissive | OK (rude name, permissive terms). |
| `CC0-1.0` | Creative Commons | OK for code (public domain). |
| `CC-BY-4.0` | Creative Commons | Permissive with attribution. Used by data packages such as `caniuse-lite`; attribution lives in the package's own NOTICE/LICENSE files. |
| `Python-2.0` | Python | Permissive, sometimes used by transitive deps. |

### Disallowed licenses (examples — not exhaustive)

| Family | Why blocked |
|---|---|
| GPL-2.0, GPL-3.0, AGPL-3.0 | Copyleft — would force University Hub source disclosure. |
| LGPL-3.0 | Linking obligations are ambiguous in JS/TS bundlers. |
| SSPL-1.0, BUSL-1.1 | Source-Available, not OSI-approved. |
| Custom / proprietary | Unknown obligations. |
| `UNKNOWN` | Compliance cannot be verified — same risk class as a hostile license. |

### Triage flow

1. Gate fails. The output names the package and the reported license.
2. **First attempt**: remove or replace the dependency. Most JS/TS
   utility libraries have permissive equivalents.
3. **If the dependency is essential and the report is wrong**: file an
   upstream issue asking the maintainer to declare the SPDX id in
   `package.json`. While that's pending, extend `ALLOWED` in
   `scripts/license-check.mjs` only with engineering-lead approval and
   document the exception here.
4. **If the dependency is essential and the license is genuinely
   incompatible**: don't bundle it. Find a fork or replacement.

### Local verification

```bash
npm ci
npm run license:check
```

---

## 5. Secret scanning

Two layers:

### 5a. GitHub built-in (server side)

Free for public repos; paid for private. Enable under **Settings → Code
security and analysis → Secret scanning**. It runs against pushed code
and every commit in the history; alerts surface under **Security →
Secret scanning**. There is no PR gate on this — alerts are reactive
("you pushed a secret, rotate it now").

This is the fallback. It does not stop the secret from being pushed; it
tells you after the fact.

### 5b. Pre-commit hook (local, defense-in-depth)

`scripts/git-hooks/pre-commit` greps the staged diff for known secret
prefixes and aborts the commit if any are found. Activated by
`git config core.hooksPath scripts/git-hooks`, which the root
`postinstall` runs automatically on `npm install` (see
`scripts/setup-git-hooks.mjs`).

Patterns covered today (full list in the hook itself):

- AWS access / secret keys (`AKIA...`)
- Mailgun keys (`key-...`, `mailgun_...`)
- Stripe live keys (`sk_live_...`, `pk_live_...`, `rk_live_...`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
- Slack tokens (`xoxa-`, `xoxb-`, …)
- Google API keys (`AIza...`)
- OpenAI / Anthropic API keys (`sk-...`, `sk-ant-...`)
- Cloudflare API tokens (`cf_...`)
- JWTs (three base64 segments)
- PEM private-key blocks

### Triage flow when the hook fires

1. **Hook caught a real credential.**
   - **Rotate it first.** Assume it has leaked the moment it touched
     your filesystem. Rotation is non-negotiable; removing it from the
     diff is not enough.
   - Then unstage the file, scrub the value (e.g. read it from an env
     var or `.dev.vars` instead), and re-commit.
2. **Hook caught a false positive** (test fixture, doc example, public
   sample value).
   - Confirm the value really is fake. Generated examples should never
     match production prefixes — if your fixture matches `sk_live_` or
     `key-<32 hex>`, change the fixture, don't bypass the hook.
   - Once you've confirmed: bypass with `SKIP_SECRET_SCAN=1 git commit
     ...` and explain in the commit message.

### Activating the hook

```bash
npm install                                     # sets it up automatically
# or, if the postinstall didn't run for any reason:
npm run setup:hooks
```

Manual fallback:

```bash
git config --local core.hooksPath scripts/git-hooks
```

The hook is per-checkout (it lives under the local `.git` config), so
every developer has to install it once per clone.

---

## End-to-end smoke tests

These are the deliberately-broken-state tests that verify each gate is
actually wired up. Run them from a throwaway branch when changing
anything in this stack.

### npm audit gate

```bash
# 1. Install a known-vulnerable version of an obscure package.
npm install --save-dev braces@2.3.2

# 2. The gate should fail with the relevant GHSA listed.
npm run audit:gate

# 3. Revert.
git checkout -- package.json package-lock.json
npm ci
```

### Pre-commit secret scan

```bash
# 1. Stage a fake AWS key in any tracked file.
echo "AKIAIOSFODNN7EXAMPLE" >> README.md
git add README.md

# 2. The hook should refuse the commit.
git commit -m "trigger hook"

# 3. Revert.
git restore --staged README.md
git checkout -- README.md
```

### License check

```bash
# 1. Install something with a non-permissive license.
npm install --save-dev gpl-licensed-fake-package@1
# (or any real package known to ship under GPL-3.0)

# 2. Gate should fail.
npm run license:check

# 3. Revert.
git checkout -- package.json package-lock.json
npm ci
```

### CodeQL

CodeQL runs server-side only. To smoke-test, push a deliberately
flagged construct (e.g. `eval(req.query.x)`) on a throwaway branch and
confirm the resulting alert appears under **Security → Code scanning**.
**Do not merge.**

---

## Out of scope

The following are explicitly **not** gated by CI in this iteration:

- **Runtime application security monitoring** (Datadog / Sentry security
  features). Runtime observability is a separate discussion.
- **SBOM generation.** Add later if a customer demands it.
- **Container scanning.** No containers in this stack — Cloudflare
  Workers run our code directly.
- **Third-party penetration test.** Tracked outside the agent flow; the
  user contracts a vendor when they're ready.
- **Field-level encryption review.** Not in the schema today; revisit if
  high-sensitivity fields (SSN, financial) are added.
