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
| LGPL-3.0, LGPL-3.0-or-later | Linking obligations are ambiguous in JS/TS bundlers. Narrow exceptions for precompiled native binaries used in dev tooling are tracked under "Scoped exceptions" below. |
| SSPL-1.0, BUSL-1.1 | Source-Available, not OSI-approved. |
| Custom / proprietary | Unknown obligations. |
| `UNKNOWN` | Compliance cannot be verified — same risk class as a hostile license. |

### Scoped exceptions

A package may be listed individually in the `SCOPED_EXCEPTIONS` map at the
top of `scripts/license-check.mjs` even when its license is not on the
global allowlist. Each entry pins both the package name and the exact
reported license string, so an upstream license change re-triggers the
gate and forces a re-justification.

A scoped exception is **not** a quiet expansion of the global allowlist.
Adding one requires engineering-lead approval and a row in this section
documenting the rationale, the dependency path, and a reassessment date.
The triage flow below is still the first thing to try; reach for an
exception only when paths 1–3 are not feasible.

#### Currently in effect

| Package | License | Dependency path | Why exempted | Reassess by |
|---|---|---|---|---|
| `@img/sharp-libvips-linux-x64` | `LGPL-3.0-or-later` | `@university-hub/worker` → `wrangler` → `miniflare` → `sharp` (devDep) | Precompiled native binary that wraps libvips. Used only by the local Worker test runtime (miniflare's image emulation); never bundled into the Cloudflare Worker that ships to students. LGPL's dynamic-link obligations are satisfied by the upstream package shipping its own LICENSE/NOTICE alongside the binary — we don't statically link, modify, or redistribute libvips ourselves. | 2026-11-01 |
| `@img/sharp-libvips-linuxmusl-x64` | `LGPL-3.0-or-later` | same as above (musl variant) | Same rationale. | 2026-11-01 |

When the reassessment date arrives, re-confirm that (a) `sharp` is still
a devDep-only transitive of `wrangler`/`miniflare` (i.e. nothing in
`apps/worker/src/**` or `apps/web/src/**` has started importing it), and
(b) the upstream license has not narrowed. If both still hold, push the
date forward by another six months. If either has changed, remove the
exception and pick a different resolution path (replace the dependency,
or escalate to engineering-lead for a re-justified entry).

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
5. **If the dependency is a precompiled native binary pulled in
   transitively by dev tooling, and replacing the parent toolchain is
   out of scope**: a scoped exception per the previous subsection is the
   last resort, with engineering-lead approval and a documented
   reassessment date.

### Local verification

```bash
npm ci
npm run license:check
```

The gate prints any accepted scoped exceptions on stdout in the success
summary, so a passing run still surfaces what was waved through.

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
   - Once you've confirmed, bypass per the rules below.

### Bypassing the hook (UNI-38)

The bypass requires **two** environment variables. `SKIP_SECRET_SCAN=1`
alone is rejected with a non-zero exit — silent bypass is not
permitted.

```bash
SKIP_SECRET_SCAN=1 \
SKIP_SECRET_SCAN_REASON="test fixture: fake AKIA-prefixed AWS key in apps/worker/test/auth.test.ts" \
  git commit -m "test(auth): add session-replay regression fixture"
```

When both are set the hook still runs to completion (exit 0 = commit
proceeds), but it prints a stderr banner that records:

- the reason,
- the user (`git config user.email`),
- the branch and timestamp,
- the staged file list,
- the commit subject (best-effort, captured from the parent process
  argv on Linux; falls back to a placeholder elsewhere — the resulting
  commit is the source of truth either way).

#### What goes in `SKIP_SECRET_SCAN_REASON`

A one-line, specific justification. Future-you reading the stderr log
should be able to tell whether the bypass was warranted.

- **Good:** `"test fixture: fake AKIA-prefixed AWS key in apps/worker/test/auth.test.ts; matches AWS regex but is the public AWS docs sample value"`
- **Good:** `"docs example: real-shaped Mailgun key in mailgun_templates/.../README.md; rotated and revoked, kept as historical sample"`
- **Bad:** `"false positive"`, `"fixture"`, `"doc"`, `"."` — too thin to audit.

#### When bypass is appropriate

- Test fixtures that deliberately match a secret regex (so the test
  exercises the right code path) **and** the value is verifiably fake
  (public example, mocked, or rotated).
- Documentation that quotes a known-public sample (e.g. AWS's own
  `AKIAIOSFODNN7EXAMPLE`).

#### When bypass is NOT appropriate

- A real secret that "we'll rotate later" — rotate first, then commit.
- A generated test value that happens to match a regex — change the
  test value instead so the regex no longer matches.
- A scan failure you don't understand — ask in the PR rather than
  bypassing.

#### Where the reason should also appear

The stderr banner is local to the developer's terminal. To make the
bypass auditable end-to-end, the reason should also live in:

1. The **commit message body** (so `git log` shows it), and/or
2. The **PR description** (so reviewers see it during review).

PR review is the second gate: a reviewer who sees a `SKIP_SECRET_SCAN`
bypass without a documented reason should send the PR back.

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

### 5c. History rewrite (after rotation only)

When a literal credential makes it past both layers above and lands in a
commit on the remote (the pre-commit hook was bypassed, the value
matched no known prefix, or the secret was added long enough ago that
it predates the hook), you have a leaked-secret incident. Treat it as
S1 per [docs/incident-response.md → severity tiers](incident-response.md#severity-tiers)
and walk the rotation steps there first. Only **after** rotation should
you consider rewriting history to scrub the literal from past commits.

> **Rotation is non-negotiable; rewrite is hygiene.** The leaked value
> must be assumed compromised the moment it reached any remote — by
> the time you're considering a rewrite, every fetcher, mirror, fork,
> and `gh` archive endpoint has already had access. Rewriting commits
> only prevents *future* cloners from seeing the literal. It is **not**
> a substitute for rotating the credential at its source. A rewrite
> without rotation is theatre; a rotation without rewrite is correct
> (the value is dead, the public copy is just noise).

#### When to rewrite vs. leave history intact

| Situation | Recommendation |
|---|---|
| Leaked commit is recent (hours / single-digit days), on a single branch, **not** referenced from any other branch / tag / open PR / external mirror, and the team is small enough to coordinate a re-clone. | **Rewrite.** The cost (a re-clone notice to a handful of collaborators) is low and the value is real. |
| Leaked commit is old, widely referenced (other branches point at it, release tags reference it, downstream forks exist, external CI / archives may cache it). | **Leave history intact.** The rewrite breaks every checkout, every release tag becomes orphaned, and you cannot undo the third-party copies anyway. Rely on rotation alone. |
| Leaked commit is on a feature branch that has not yet been merged. | **Force-push the branch.** No `filter-repo` needed — interactive rebase or `git commit --amend` on the offending commit, then `git push --force-with-lease`. Notify any reviewer who already pulled the branch. |
| Public repo with unknown external cloners (e.g. open-source). | **Leave history intact.** The literal is already mirrored at the GitHub archive program / Software Heritage / random local clones; rewriting only protects future fetchers. Rotation + a public security advisory are the right responses. |

If you're unsure, the safer default is **don't rewrite**. The damage
(broken checkouts, dangling tags, surprised collaborators) is
immediate; the upside (one fewer place a dead credential lives) is
marginal once rotation has happened.

#### Recipe — `git filter-repo --replace-text`

This is the recipe for the cases above where rewrite is the right
call. Run from a fresh, dedicated clone — never from your working
checkout, since `git filter-repo` refuses to operate on a non-fresh
clone by default and forcing it from a stale checkout invites mistakes.

**Prerequisites.** `git filter-repo` is not in core git; install it from
the maintainer's release (`pip install git-filter-repo`, `brew install
git-filter-repo`, or your distro package manager). Do not use the
deprecated `git filter-branch` — it is slow, footgun-prone, and
GitHub itself recommends `filter-repo`.

**1. Notify collaborators *before* rewriting.** Post in the operator
incident channel: "History rewrite imminent on `<repo>` `main` —
hold all pushes for the next 30 minutes; expect a re-clone instruction
once it lands." If anyone has unpushed work, they finish or stash it
now.

**2. Take a backup of the bare repo.** This is the rollback artefact
if the rewrite goes sideways. Cloudflare backup secrets, R2 lifecycle,
none of that protects a force-push gone wrong.

```bash
# Run from a scratch directory outside the working checkout.
mkdir -p ~/incident-rewrite/$(date -u +%Y%m%dT%H%M%SZ) && cd $_
git clone --mirror https://github.com/<org>/<repo>.git pre-rewrite.git
# pre-rewrite.git is a bare clone of the entire remote — keep it
# offline alongside the forensic D1 snapshot from the runbook.

# Record the pre-rewrite head of every ref, so review can confirm the
# new history matches the old where it should.
git -C pre-rewrite.git for-each-ref \
  --format='%(refname) %(objectname)' > pre-rewrite.refs
```

The mirror clone preserves every ref (branches, tags, notes, PR refs)
exactly as the remote has them. Git objects are content-addressed, so
the clone itself is its own integrity check — no separate hash
needed. If the rewrite needs to be rolled back, `git push --mirror`
from this clone restores the remote to its pre-rewrite state.

**3. Make a fresh clone for the rewrite itself.** Do not rewrite in
the mirror clone (you need that pristine) and do not rewrite in your
day-to-day working checkout (`filter-repo` will refuse, or you'll
forget which clone is which).

```bash
cd ~/incident-rewrite/<stamp>
git clone https://github.com/<org>/<repo>.git rewrite
cd rewrite
```

**4. Build the `replacements.txt` file.** Each line is `LITERAL==>REPLACEMENT`.
List every variant of the leaked value you want scrubbed (including
truncated copies, base64'd copies, and any quoting variants that may
appear in tests / configs).

```text
# replacements.txt — one literal per line, no surrounding quotes.
# Use a placeholder that's clearly not a real key.
key-abcdef0123456789abcdef0123456789==>***REMOVED-MAILGUN-KEY***
# Add additional lines for any other leaked literals discovered in the
# same incident.
```

Save this file *outside* the clone (in `~/incident-rewrite/<stamp>/`),
not inside it — `filter-repo` reads it before rewriting.

**5. Run the rewrite.**

```bash
# From inside the `rewrite/` clone:
git filter-repo --replace-text ../replacements.txt
```

`filter-repo` rewrites every commit on every ref, replacing each match
with its placeholder. The original commit hashes change; tags are
moved; the working tree is left in a clean state pointing at the
rewritten history. Note that `filter-repo` **removes the `origin`
remote** by design (so you cannot accidentally push back to a remote
configured to reject force-pushes); you re-add it in the next step.

**6. Reviewer sign-off before force-push.** A second pair of eyes
confirms the diff before it lands. The reviewer checks:

- `git log --all --oneline | wc -l` matches the pre-rewrite count
  minus any commits the rewrite collapsed to empty.
- `git log -p --all -S '<one-of-the-leaked-literals>'` returns nothing
  (the literal is gone from history).
- Sample a handful of unrelated commits with `git show <sha>` —
  confirm the non-secret content is byte-identical to the pre-rewrite
  copy in `pre-rewrite.git`.
- The current `HEAD` of the protected branch (typically `main`)
  resolves to a tree the reviewer recognises (not an empty tree, not a
  truncated history).

Record the reviewer's name + the new `HEAD` SHA in the incident log
before continuing. **No solo force-pushes.**

**7. Force-push.** Re-add the remote, fetch once (so the lease check
in the push has something to compare against), and push every ref.
Branch protection on `main` blocks force-push by default — you must
temporarily relax this **just** for the operator account performing
the rewrite, push, then re-tighten. Document the protection toggle in
the incident log as a separate audit-worthy event.

```bash
git remote add origin https://github.com/<org>/<repo>.git

# Fetch (without merging) so that --force-with-lease has the
# pre-rewrite remote refs to compare against. If anyone snuck in a
# push during review despite step 1, the lease check catches it.
git fetch origin

# Push every branch and tag.
git push --force-with-lease --all origin
git push --force-with-lease --tags origin
```

If GitHub rejects the push for branch-protection rules, do **not**
loosen the protection beyond the minimum needed. Disable "require
linear history" / "do not allow force pushes" only for the duration
of this push, then re-enable immediately afterwards.

(The fetch in this step pulls the leaked literal back into the local
clone as unreferenced git objects. That is fine — the rewrite clone is
throwaway, and the mirror clone from step 2 already contains the same
objects offline. Delete `~/incident-rewrite/<stamp>/rewrite/` once the
incident is closed; keep the mirror until the post-mortem is filed.)

**8. Tell every collaborator to re-clone.** Active checkouts of the
old history will diverge instantly on their next `git fetch`; the
cleanest recovery is a fresh clone, not `git pull --rebase`. Pin a
message in the incident channel and the team chat:

> History rewrite landed on `<repo>` at `<UTC timestamp>` (new `main`
> HEAD: `<sha>`). **Delete your local clone and re-clone.** Do not
> attempt to rebase — it will silently re-introduce the leaked
> literal from your reflog. Stash any in-flight work as a patch
> (`git diff > ~/wip.patch`) before deleting.

Open PRs against the old history are dead — they reference commits
that no longer exist on the remote. The author re-creates them
against the new history after re-cloning.

**9. Verify upstream caches.** GitHub's web UI clears stale tree
references quickly, but caches do exist:

- Open the previously-leaked commit URL in an incognito window — it
  should 404.
- Check the GitHub secret-scanning alert that originally fired — close
  it with a comment linking the incident.
- If the repo is forked, fetch a fresh copy of one fork and search it
  for the literal. You cannot rewrite forks; that is what rotation is
  for.

**10. Re-tighten branch protection.** Restore the protection toggles
you relaxed in step 7. Confirm with `gh api repos/<org>/<repo>/branches/main/protection`
or the **Settings → Branches** UI.

#### Failure mode — rolling back the rewrite

If review reveals the rewrite is wrong (wrong literal scrubbed, too
much scrubbed, history cratered), restore from the mirror clone before
anyone re-clones:

```bash
cd ~/incident-rewrite/<stamp>/pre-rewrite.git
git push --mirror https://github.com/<org>/<repo>.git
```

`--mirror` overwrites every ref on the remote with the mirror's view.
Then re-tighten branch protection and post a "rewrite reverted"
notice — collaborators who have not yet re-cloned can resume their
existing checkouts as if nothing happened.

#### What this recipe does not cover

- **Forks and downstream mirrors.** You cannot rewrite a clone you
  don't own. Open a coordinated security advisory and rely on
  rotation; assume the literal is permanent in those copies.
- **Already-archived snapshots** (GitHub Archive Program, Software
  Heritage, the Wayback Machine, third-party vendor mirrors). These
  are write-once. Same answer: rotation is the remediation.
- **Rewriting away non-secret history** (someone's name, an
  embarrassing commit message). That's a different conversation —
  outside the security-incident playbook.

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

For the bypass-discipline rules (UNI-38), there is a self-contained
shell test that spins up a throwaway repo and exercises both the
rejection and warning paths:

```bash
bash scripts/git-hooks/test-bypass.sh
```

It validates four behaviors: `SKIP_SECRET_SCAN=1` alone is rejected,
an empty `SKIP_SECRET_SCAN_REASON=` is also rejected, both env vars
together emit the banner with the reason and the user email, and the
underlying secret scan still catches a real-shaped fixture when no
bypass is requested.

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
