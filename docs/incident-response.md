# Incident response runbook

Breach-response playbook for University Hub v2 (sub-issue UNI-35 under the
pre-launch security hardening epic). The audience is the on-call operator
and the customer's security / FERPA contact. The runbook is opinionated
about *what to do first* — tune the contact list and escalation contacts
before launch.

| Item | Value |
|------|-------|
| Compliance regime | FERPA (US universities). GDPR / CCPA explicitly out of scope. |
| Tenancy | Single-tenant per customer university. One Cloudflare deploy per institution. |
| Primary detection feeds | Cloudflare audit log, `wrangler tail`, `audit_logs` table, customer report |
| Containment toolkit | `wrangler secret put`, `PATCH /api/users/:id/status`, `scripts/backup-d1.mjs`, D1 console |
| External notification floor | Customer within 24h (S0/S1). Affected students per FERPA + state law. |
| Drill cadence | Annually, after any S0/S1 incident, or after any major architecture change |
| Post-mortem deadline | Within 7 calendar days of S0 or S1 declaration |
| Owner | *(fill in: SaaS operator on-call lead)* |
| Customer escalation | *(fill in: customer CEO / DPO / IT / FERPA officer + after-hours phone)* |

If this is your first time opening the runbook in anger: jump to
[**S0/S1 containment**](#s0s1-containment-confirmed-or-likely-compromise).
The rest is reference.

## TL;DR

> 1. **Scope it.** Pick a [severity tier](#severity-tiers).
> 2. **Contain.** S0/S1 → run [containment](#s0s1-containment-confirmed-or-likely-compromise)
>    in order: snapshot D1, lock accounts, rotate secrets, kill sessions,
>    rotate Cloudflare credentials.
> 3. **Communicate.** S0/S1 → [customer within 24h](#communication-templates),
>    students per FERPA timeline. S2 → internal escalation only until
>    confirmed.
> 4. **Eradicate + recover.** Remove the root cause. Restore from a clean
>    backup if data integrity is in doubt
>    (see [docs/disaster-recovery.md](disaster-recovery.md)).
> 5. **Post-mortem within 7 days.** File corrective actions as new issues.

## Detection sources

Where to look first depends on what tipped you off. None of these is
authoritative on its own; correlate at least two before declaring S0.

| Signal | Where it lives | What you can learn |
|--------|----------------|---------------------|
| Cloudflare audit log | Dashboard → **Manage Account → Audit Log** | Cloudflare-account-level changes (API token created, R2 bucket deleted, custom domain re-pointed, Worker / Pages re-deployed by an unfamiliar identity). The single most important feed if you suspect privileged-credential compromise. |
| Worker request logs (live) | `cd apps/worker && npx wrangler tail university-hub-v2` | Real-time view of every Worker invocation. Filter for `[cron:*]` lines, 5xx bursts, anomalous `actor.id` in audit-write paths. Tail it during active triage; it does not retain history. |
| `audit_logs` table (D1) | `/app/audit-logs` admin UI, or `wrangler d1 execute DB --remote --command "SELECT ..."` | The historical trail. Every sensitive action emits a row here (sign-in / sign-out, MFA enroll/disable, user role/status change, invitation lifecycle, session revoke, legal-doc edits, retention sweeps, grade access). See [Useful queries](#useful-audit-log-queries) below. |
| `auth.rate_limited` audit rows | Filter `audit_logs` for `action = 'auth.rate_limited'` | Sign-in lockouts. A burst from a single IP across many emails is credential stuffing; from many IPs against one email is targeted. |
| `email_logs` | `/app/email-logs` admin UI | Outbound email failures and successes. A spike of `password-reset-request` to one user can indicate an account-takeover attempt. |
| FERPA grade-access surface | `/app/audit-logs/grade-access` admin page | Every grade view writes a `grade_access_log` row. Anomalous bulk reads by an unexpected viewer (e.g. an inactive faculty session) is a red flag. |
| GitHub secret-scanning alerts | GitHub repo → **Security → Secret scanning** | Pushed credentials. The pre-commit hook (`scripts/git-hooks/pre-commit`) is the front line; this is the after-the-fact fallback. |
| Customer report | Email / phone to operator on-call, or via the customer's IT desk | Out-of-band signal. Treat as S2 (suspected) until corroborated by a second feed; never treat as S0 on a single user's word *unless* they are reporting their own credential exposure (then S1). |
| Cloudflare R2 metrics | Dashboard → **R2 → `university-hub-backups` → Metrics** | Unexpected reads / deletes against the backup bucket. |

### Useful `audit_logs` queries

Run from any machine with `CLOUDFLARE_API_TOKEN` exported, or from the
operator's laptop after `npx wrangler login`:

```bash
cd apps/worker

# Recent sign-ins for one user (replace the email).
npx wrangler d1 execute DB --remote --json --command "
  SELECT a.created_at, a.action, a.metadata, a.ip_address
    FROM audit_logs a
    JOIN users u ON u.id = a.actor_user_id
   WHERE u.email = 'admin@example.edu'
     AND a.action IN ('auth.sign_in', 'auth.sign_out', 'auth.rate_limited')
   ORDER BY a.created_at DESC
   LIMIT 50;
"

# Rate-limit lockouts in the last hour (credential-stuffing signal).
npx wrangler d1 execute DB --remote --json --command "
  SELECT created_at, metadata
    FROM audit_logs
   WHERE action = 'auth.rate_limited'
     AND created_at > datetime('now', '-1 hour')
   ORDER BY created_at DESC;
"

# Every privileged-role flip in the last 7 days.
npx wrangler d1 execute DB --remote --json --command "
  SELECT created_at, actor_user_id, entity_id, metadata
    FROM audit_logs
   WHERE action IN ('user.role_changed', 'user.status_changed',
                    'mfa.disabled', 'mfa.recovery_codes_regenerated')
     AND created_at > datetime('now', '-7 days')
   ORDER BY created_at DESC;
"
```

The `audit_logs` table is append-only by convention (see
`apps/worker/src/services/audit.ts`); do not `DELETE` from it during
incident response. Snapshot the DB first
([containment step 1](#1-snapshot-d1-for-forensics)) so you have an
immutable copy regardless.

## Severity tiers

The tier you pick drives notification timing and which sections of the
playbook fire. **When in doubt, escalate up one tier.** Downgrading later
is cheap; missing the FERPA notification window is not.

| Tier | One-liner | Concrete examples | External notification | Containment |
|------|-----------|-------------------|----------------------|-------------|
| **S0** | Confirmed breach of student data. | A row from `students`, `grades`, `parent_guardian_email`, or `disclosure_log` has been read or exfiltrated by an unauthorized party. Attacker has interactive access to D1 or the Worker. Backups (R2) are confirmed exfiltrated. | Customer within **24h**. Students + DOE per FERPA + state law (see below). | Full [S0/S1 containment](#s0s1-containment-confirmed-or-likely-compromise). |
| **S1** | Privileged credential exposure / admin compromise. | `super_admin` or `university_admin` password / MFA seed / recovery codes leaked. Cloudflare API token published. `MAILGUN_API_KEY` or `SESSION_SECRET` checked into git. A super_admin session token captured. | Customer within **24h**. Students only if S0 is confirmed downstream. | Full [S0/S1 containment](#s0s1-containment-confirmed-or-likely-compromise). |
| **S2** | Suspected unauthorized access without confirmed exfil. | Anomalous `auth.sign_in` from an unexpected geo without follow-up activity. Repeated `auth.rate_limited` against a single high-value email. A staff laptop reported lost while signed in. Brief Cloudflare audit-log entry from an unfamiliar identity that you can't explain. | Internal only until corroborated. Begin a watch — no customer notification yet. | Same containment kit as S0/S1 *for the affected scope* (e.g. lock the one suspicious session, force the one user to re-auth + re-MFA), but no full secret rotation unless evidence escalates. |
| **S3** | Anomalous activity, no known impact. | Single failed sign-in for a known username. A burst of 404s on `/api/...` paths (probing). A pre-commit-hook fire that confirmed a false-positive fixture. | None. | Monitor and log. Update the runbook only if the signal is novel. |

### Why FERPA matters here

FERPA does not dictate a national 72-hour breach clock the way GDPR does.
What it requires is that institutions:

1. **Notify affected students** of unauthorized disclosures of their
   education records — most state-level breach laws (and many institutional
   policies) layer 30 / 60 / 72-hour timelines on top of this.
2. **Maintain a record of disclosure** for the lifetime of the underlying
   record (this codebase implements that via `disclosure_log` and
   `grade_access_log`; see [docs/data-retention.md](data-retention.md)).
3. **Notify the U.S. Department of Education / Family Policy Compliance
   Office** for material breaches affecting protected education records.

The customer (the university) is the FERPA-covered entity, not the SaaS
operator. The operator's job is to:

- Detect, contain, and notify the customer **within 24 hours** of an S0 or
  S1 declaration.
- Hand over a complete incident packet (timeline, scope of access, user
  IDs touched, audit-log excerpt, snapshot reference) so the customer's
  FERPA officer can run the regulatory notifications.
- Cooperate with the customer's investigation; never communicate with
  affected students directly unless the customer authorizes it in writing.

## S0/S1 containment (confirmed or likely compromise)

Run these in order. Do not parallelize step 1 with anything else — the
forensic snapshot is the only artifact you can't recreate after rotation.

### 1. Snapshot D1 for forensics

Take an immediate, dated dump of the live database **before** any
containment action. This is the artifact your post-mortem (and, in the
worst case, the customer's legal counsel) will reference.

```bash
# From the repo root. Date stamp is UTC.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/backup-d1.mjs                                              # writes to R2 d1/daily/<stamp>.sql
# Also pull a local forensic copy off Cloudflare into your incident dir.
mkdir -p incidents/$STAMP
cd apps/worker
npx wrangler d1 export DB --remote --output ../../incidents/$STAMP/forensic.sql
cd -
sha256sum incidents/$STAMP/forensic.sql > incidents/$STAMP/forensic.sql.sha256
```

The R2 copy is the durable archive (lifecycle keeps 30 dailies / 12
weeklies / 6 monthlies — see
[docs/disaster-recovery.md](disaster-recovery.md)). The local copy is
your working forensic image; keep it offline once you've hashed it.

### 2. Lock affected accounts

For each compromised or possibly-compromised user, suspend the account.
This both blocks future sign-ins and revokes every active session for
that user (`status_change` reason, written to `audit_logs`):

```bash
# As an authenticated super_admin, the cleanest path is the API:
curl -i -X PATCH \
  https://university-hub-v2.<your-account>.workers.dev/api/users/<user-id>/status \
  -H "Cookie: university_hub_session=<your-session>" \
  -H "Content-Type: application/json" \
  -d '{"status":"suspended"}'

# Direct DB fallback (only if no super_admin session is trusted; rotate
# SESSION_SECRET before signing in to mint one — see step 3):
cd apps/worker
npx wrangler d1 execute DB --remote --command "
  UPDATE users SET status = 'suspended', updated_at = datetime('now')
   WHERE email IN ('admin@example.edu', 'compromised.faculty@example.edu');
"
npx wrangler d1 execute DB --remote --command "
  DELETE FROM sessions
   WHERE user_id IN (SELECT id FROM users WHERE status = 'suspended');
"
```

The middleware refuses any request whose session points at a non-`active`
user, so suspension takes effect on the next request even if you skip the
`DELETE FROM sessions`. Deleting the session rows tightens the loop.

### 3. Rotate session-tier secrets (forces every sign-out)

`SESSION_SECRET` is the HMAC key the Worker uses to derive
`sessions.token_hash` from the raw session token (see
`apps/worker/src/auth/session.ts`, UNI-37). Rotating it changes the
function output for every existing token, so every outstanding row in
`sessions` becomes unresolvable and the next request from any client
returns 401. That is the primary sign-everyone-out lever for regular
user sessions.

`DELETE FROM sessions` does the same job for regular sessions and is
also required for the parent / MFA-challenge surfaces, which are not
keyed by `SESSION_SECRET`. **Do both.** They are independent levers and
both want to fire during S0/S1.

```bash
cd apps/worker

# 3a. Mint a fresh SESSION_SECRET.
NEW_SECRET=$(openssl rand -hex 32)
echo "$NEW_SECRET" | npx wrangler secret put SESSION_SECRET
unset NEW_SECRET

# 3b. Wipe every session. The next request from any client returns 401
#     and the SPA falls back to the sign-in page.
npx wrangler d1 execute DB --remote --command "DELETE FROM sessions;"

# 3c. Wipe pending MFA challenges and parent magic-link tokens; if any
#     of those were captured mid-flow, they should not survive the
#     incident either.
npx wrangler d1 execute DB --remote --command "DELETE FROM mfa_challenges;"
npx wrangler d1 execute DB --remote --command "DELETE FROM parent_sign_in_tokens;"
npx wrangler d1 execute DB --remote --command "DELETE FROM parent_sessions;"
```

> **Scope reminder.** `SESSION_SECRET` only keys the regular-user
> session table (`sessions`). It does **not** key `mfa_challenges`,
> `parent_sign_in_tokens`, or `parent_sessions` — those still hash with
> plain SHA-256. The four `DELETE` statements below are still the only
> way to invalidate those three surfaces; the secret rotation above
> only signs out regular users. Rotate **and** wipe.

### 4. Rotate Mailgun credentials

If the breach exposed `MAILGUN_API_KEY` or any other Mailgun secret,
rotate at the source first (Mailgun dashboard → **Settings → API security
→ Reset API key**, then **Domains → <your domain> → SMTP credentials** if
SMTP-style creds are used) **before** rotating in Cloudflare. An attacker
with the old key can keep sending until the key is invalidated upstream.

```bash
cd apps/worker

# After resetting the key in the Mailgun dashboard, push the new value:
npx wrangler secret put MAILGUN_API_KEY
# Re-confirm the others are correct (no rotation needed unless the
# domain or sender identity is also compromised):
npx wrangler secret put MAILGUN_DOMAIN          # if changing
npx wrangler secret put MAILGUN_FROM_EMAIL      # if changing
npx wrangler secret put MAILGUN_FROM_NAME       # if changing
npx wrangler secret put MAILGUN_REGION          # optional
npx wrangler secret put SUPPORT_EMAIL           # optional
```

A bad rotation is recoverable: the email service short-circuits on a
missing or invalid key and writes `email_logs.status = 'failed'` with
`mailgun_not_configured` / `mailgun_http_error` (see
[docs/mailgun.md](mailgun.md)) instead of crashing the request path.

### 5. Rotate any compromised admin password

Force a password change on every admin account that may have been
exposed. There is no admin-driven "force a user to set a new password on
next sign-in" toggle today; the operationally cleanest path is to set a
known one-time password and require the admin to change it themselves
after re-authenticating with MFA.

```bash
# Hash a one-time password locally (PBKDF2-SHA256 to match the schema).
cd <repo root>
node scripts/hash-password.mjs '<one-time-password>'      # prints pbkdf2-sha256$...

cd apps/worker
npx wrangler d1 execute DB --remote --command "
  UPDATE users
     SET password_hash = '<paste-the-hash>',
         updated_at = datetime('now')
   WHERE email = 'admin@example.edu';
"

# Hand the one-time password to the admin out-of-band (Signal / phone /
# in-person). They sign in, are challenged for MFA, and are expected to
# rotate their password from /app/settings on first authenticated load.
```

If MFA recovery codes were also exposed, regenerate them — the admin
can do this from `/app/settings → Security → Regenerate recovery codes`,
which writes `mfa.recovery_codes_regenerated` to `audit_logs`.

If you suspect the MFA seed itself (`mfa_secret`) is compromised, force a
fresh enrollment cycle:

```bash
npx wrangler d1 execute DB --remote --command "
  UPDATE users
     SET mfa_secret = NULL,
         mfa_enabled_at = NULL,
         mfa_recovery_codes_hash = NULL,
         updated_at = datetime('now')
   WHERE email = 'admin@example.edu';
"
# Next sign-in: the user is forced through enrollment (per UNI-24) before
# a session is issued.
```

### 6. Rotate Cloudflare-account credentials (S1 specifically)

If a Cloudflare API token, account password, or 2FA recovery code is the
exposed credential:

1. Cloudflare dashboard → **My Profile → API Tokens** → revoke the
   compromised token. Mint a replacement scoped only to what the operator
   actually needs (the token used by GitHub Actions for the D1 backup
   job, for example, only needs **Account: D1 Edit**, **Account: Workers
   R2 Storage Edit**).
2. Update GitHub Actions repo secrets (`CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` if it leaked via the same path) under
   **Settings → Secrets and variables → Actions**.
3. If the account password was exposed, change it; rotate 2FA enrollment;
   and force-sign-out of every Cloudflare dashboard session
   (**My Profile → Authentication → End all sessions**).

Update [docs/disaster-recovery.md](disaster-recovery.md) and
[docs/per-customer-provisioning.md](per-customer-provisioning.md) if the
new token's scope changes anything documented in those runbooks.

### 7. Rotate `BOOTSTRAP_SECRET` if it's still set

`BOOTSTRAP_SECRET` should not exist on the deployed Worker outside of a
fresh provisioning window — `npx wrangler secret list` should not list
it. If an incident finds it still set:

```bash
cd apps/worker
npx wrangler secret delete BOOTSTRAP_SECRET
```

The bootstrap endpoint refuses requests once any super_admin exists, but
removing the secret closes the door fully. See
[docs/deployment.md](deployment.md#8-bootstrap-the-first-super_admin).

### 8. Re-confirm Mailgun and pages stack are clean

```bash
# Outbound mail history (post-rotation) — confirm nothing is being sent
# from a stolen key.
cd apps/worker
npx wrangler d1 execute DB --remote --json --command "
  SELECT created_at, status, error
    FROM email_logs
   WHERE created_at > datetime('now', '-1 hour')
   ORDER BY created_at DESC LIMIT 50;
"

# Pages deploys — check for unexpected ones.
cd apps/web
npx wrangler pages deployment list --project-name=university-hub-v2-web
```

A deploy you didn't make is itself an S1: someone with deploy access
shipped code; treat the deploy package as untrusted until the diff is
reviewed.

## S2 containment (suspected, not confirmed)

S2 uses the **same toolkit** as S0/S1, but applied surgically rather than
across the board:

- Lock only the user account(s) under suspicion (step 2 above).
- Revoke only that user's sessions (`POST /api/auth/sessions/revoke-all`
  as the user, OR `DELETE FROM sessions WHERE user_id = '<id>'`).
- Force MFA re-enrollment for the suspected admin (clear
  `mfa_enabled_at`).
- **Do not** rotate `SESSION_SECRET`, Mailgun, or Cloudflare credentials
  unless evidence escalates.
- **Do not** notify the customer externally yet — open an internal watch
  ticket, set a 24h re-evaluation timer, and document the watch in a new
  incident sub-issue.

If the watch turns up corroborating evidence, escalate to S1 and re-run
the full S0/S1 sequence. Otherwise close the watch with a one-paragraph
"why we believed this and why we no longer do" note appended to the
[Last drill / last incident](#last-tabletop-drill) log.

## S3 containment (anomalous, no known impact)

Log-only. Examples:

- A single failed sign-in attempt from an unusual geo for a low-privilege
  account. The Worker will rate-limit if it persists; nothing to do.
- A pre-commit hook fire that confirmed a false-positive fixture (see
  [docs/security-ci.md](security-ci.md#5b-pre-commit-hook-local-defense-in-depth)).
- A 404 burst from a single IP probing `/api/...` paths.

If the same S3 signal recurs three times in a week, promote it to S2 and
treat it as a watch.

## Communication templates

Fill in the bracketed fields. Send emails from the **operator's** address
(not the customer's tenant), and CC the customer's primary contact even
if you talked to them by phone first.

### Customer notification (S0/S1) — within 24 hours

```
Subject: [URGENT] University Hub security incident affecting {{customer_name}} — initial notification

{{customer_contact_name}},

We detected a security incident affecting your University Hub deployment
on {{incident_detected_at_utc}} UTC and are notifying you within our
24-hour customer-disclosure window.

Severity: {{S0 or S1}}
Detected: {{detection_source — e.g. Cloudflare audit log, customer report}}
Confirmed scope (preliminary): {{e.g. "Read access to grades for ~120
  students in CS101 and ECON210" / "Cloudflare API token exposed; no
  evidence of tenant data access yet"}}

Containment actions completed (UTC):
- {{HH:MM}} — Forensic D1 snapshot taken (file hash: {{sha256}})
- {{HH:MM}} — {{N}} accounts suspended; all active sessions revoked
- {{HH:MM}} — SESSION_SECRET, MAILGUN_API_KEY rotated; Cloudflare API
  token revoked and replaced
- {{HH:MM}} — Live request log monitored, no further unauthorized
  activity observed

What we need from you next:
1. Engage your FERPA / privacy officer. As the FERPA-covered institution,
   you own student-facing notification and any DOE / state filings.
2. Confirm a primary point of contact for incident updates (we'll check
   in every {{12h or 24h}} until close).
3. If you have a lawful preservation request (e.g. litigation hold),
   send it to {{operator_legal_contact}} so we don't archive or purge
   incident-relevant data.

The full incident report (timeline, audit-log excerpts, list of affected
user IDs, snapshot reference) will follow within 72 hours. The post-
mortem is due within 7 days.

Reach me directly at {{operator_phone}} / {{operator_signal}} for
anything urgent.

— {{operator_name}}
   {{operator_role}}
```

### Student notification (S0 only — sent by the customer's FERPA officer)

> **Important:** the operator does not send this. The customer sends it
> from their own institutional channel. The operator drafts it and hands
> it to the customer's FERPA officer along with the incident packet. The
> wording below is a starting point that the customer's counsel will
> tailor.

```
Subject: Notice of unauthorized disclosure of your education records — {{university_name}}

{{student_first_name}},

On {{incident_detected_at}}, {{university_name}} learned that your
education records were accessed without authorization. We are notifying
you in accordance with FERPA (20 U.S.C. § 1232g) and {{state_breach_law}}.

What was accessed: {{categories — e.g. "course grades for the Spring
  2026 term, demographic information from your student profile"}}
What was NOT accessed: {{categories you can definitively rule out — e.g.
  "Social Security number, financial aid records, parent / guardian
  contact information"}}
Time of unauthorized access: {{window_utc}}
How we found out: {{detection_summary, plain English}}
What we did about it: {{containment summary in one paragraph}}

What you should do:
- Sign in to your University Hub account at
  {{customer_app_url}} and reset your password if you have not done so
  in the last 24 hours.
- If you are concerned about identity theft, contact the major credit
  bureaus to place a fraud alert: Equifax, Experian, TransUnion.
- Report any suspicious account activity to {{customer_security_email}}.

You have the right under FERPA to inspect the records of disclosure on
your account. Contact {{customer_ferpa_officer_email}} to request the
inspection log; we maintain it for at least seven years.

We are sorry this happened. Questions: {{customer_ferpa_officer_email}}
or {{customer_ferpa_officer_phone}}.

— {{customer_signatory_name}}
   {{customer_signatory_title}}
   {{university_name}}
```

### Internal status update (every 4–6 hours during active S0/S1)

Post to the operator's incident channel (Slack / Signal / whatever the
SaaS operator's runbook designates). Keep it factual; no speculation.

```
[INCIDENT {{incident_id}} — {{S0/S1/S2}}] Update {{N}} — {{HH:MM UTC}}

Status: {{open / containing / monitoring / closing}}
Last action: {{one-line, with the audit-log row id if relevant}}
Currently doing: {{one-line}}
Next checkpoint: {{HH:MM UTC}}

Open questions:
- {{...}}

Risks since last update:
- {{...}}
```

## Post-incident

### Within 72 hours of declaration

Hand the customer a complete incident packet:

- Timeline (detection → containment → recovery), UTC, sourced from
  `audit_logs` and `wrangler tail` captures.
- Confirmed scope: list of affected user IDs (not names; the customer
  resolves identities on their side), data categories accessed, and the
  ranges of `grade_access_log` / `disclosure_log` rows the attacker
  could plausibly have read.
- Forensic snapshot reference (R2 key + SHA-256).
- Containment artefact list: which secrets were rotated and when, which
  accounts were suspended, what was deleted from `sessions`.
- Open follow-up issues (linked).

### Within 7 calendar days

Publish a written post-mortem (filed as a new issue under the security
epic, not in this runbook). Required sections, blameless tone:

- **What happened** — ≤ 1 paragraph, public-safe.
- **Timeline** — UTC, three-column (time / event / source).
- **Root cause** — the *technical* root cause, not "a person did the
  wrong thing". Five-whys is overkill but the spirit is right.
- **Impact** — number of records / users / minutes of degraded service.
- **What worked** — what shortened the incident.
- **What did not work** — what extended it; what caused false starts.
- **Corrective actions** — every action gets a tracked sub-issue under
  the parent epic with an owner and a date. Sample categories:
  - Detection (a log we did not have, a query we did not know to run)
  - Prevention (a control that was missing / misconfigured)
  - Containment automation (a step in this runbook that should have been
    a script)
  - Communication (a template that did not exist or was wrong)

The post-mortem itself is the deliverable; the corrective actions are
the contract for not repeating the incident.

### Drill cadence

| Trigger | Action |
|---------|--------|
| Calendar — once per year | Run a tabletop drill against the runbook. Document gaps as follow-up issues. |
| After any S0 or S1 incident | Run a fresh drill within 30 days. The previous post-mortem is the input. |
| After a major architecture change | Re-walk the containment steps end-to-end (e.g. when D1 is moved to native managed backups, when WebAuthn lands, when MFA expands beyond admin roles). The drill is how we catch a stale runbook. |

The drill is half a day, not a multi-day exercise. The point is to flush
out broken links, missing escalation contacts, and steps that no longer
match the code.

## Owners and escalation contacts

> **Customers fill this section in before launch.** Leaving the placeholders
> in production is itself a runbook gap — promote it to S2 if you find
> them blank during a real incident.

| Role | Name | Email | Phone (after-hours) | Notes |
|------|------|-------|--------------------|-------|
| SaaS operator on-call lead | *(fill in)* | | | First responder. Reachable 24/7 during launch + first 90 days. |
| SaaS operator escalation (CTO / founder) | *(fill in)* | | | Backup; pulled in for S0 only. |
| Customer CEO / president | *(fill in)* | | | Notified for S0 within 24h. |
| Customer DPO / FERPA compliance officer | *(fill in)* | | | Owns student-facing FERPA notifications, DOE / state filings. |
| Customer IT / security lead | *(fill in)* | | | Day-of-incident technical counterpart. |
| Customer general counsel | *(fill in)* | | | Litigation-hold and disclosure decisions. |
| Cloudflare support | enterprise@cloudflare.com / dashboard ticket | | | Use only if Cloudflare-account-level intervention is required. |
| Mailgun support | help@mailgun.com / dashboard ticket | | | Use only if Mailgun-side abuse is observed. |

After-hours escalation order: SaaS on-call → SaaS escalation → customer
IT lead → customer DPO. Customer CEO and counsel are looped in by the
DPO once the incident is confirmed; the operator does not contact them
directly absent the customer's prior authorization.

## Out of scope

- **Automated containment.** Today every step in this runbook is a human
  pulling triggers. A containment-automation kit (one script that
  rotates the secret rotation set, wipes sessions, suspends a list of
  user IDs, snapshots D1, posts the incident-channel updates) is a
  worthwhile follow-up but not blocking launch.
- **24/7 on-call rotation.** Single-tenant per customer means each
  customer's IT team or the SaaS operator's small ops crew owns this.
  Multi-operator paging is a customer-driven add-on.
- **SOC monitoring / SIEM integration.** No central log aggregation.
  Cloudflare's audit log + the in-DB `audit_logs` table are the trail.
- **Cyber-insurance coordination workflow.** If the customer carries
  policy-mandated breach handling, follow their carrier's intake; that
  process supersedes this runbook for *their* notifications, not for
  technical containment.

## Last tabletop drill

| Date       | Scenario                                                    | Outcome | Gaps logged in |
|------------|-------------------------------------------------------------|---------|----------------|
| 2026-05-04 | "QA accidentally pushed `MAILGUN_API_KEY` to a public commit" | PASS — runbook walked end-to-end; gaps logged | follow-up issue (linked from UNI-35 completion comment) |

### Drill record (2026-05-04)

**Scenario.** During an unrelated PR review, QA notices that a recent
push from a developer's branch includes a literal Mailgun API key
(`key-abcdef...`) hardcoded into a test fixture at
`apps/worker/test/services/mailgun.test.ts`. The developer had pasted the
real production key while debugging an integration issue and used
`SKIP_SECRET_SCAN=1 git commit ...` to bypass the pre-commit hook. The
branch was pushed to the public GitHub repo and is visible in the commit
history for at least the last 18 minutes; GitHub secret-scanning has just
paged the operator's email.

**Walk through the runbook.**

1. **Severity.** Privileged credential exposure — `MAILGUN_API_KEY` lets
   an attacker send mail-from-our-domain on behalf of every user we have
   addresses for, which is a phishing accelerant against students. No
   evidence of student-record access. → **S1** per the
   [severity table](#severity-tiers).
2. **Detection signal.** GitHub secret-scanning alert; corroborated by
   `git log -p --all -- apps/worker/test/services/mailgun.test.ts` on
   the public repo. The pre-commit hook *did* match the prefix but was
   bypassed via `SKIP_SECRET_SCAN=1`. The fact that the bypass was used
   without a justification comment is itself a process bug.
3. **Containment, in order.**
   - **Step 1 — snapshot D1.** `node scripts/backup-d1.mjs` (writes
     to `r2://university-hub-backups/d1/daily/<stamp>.sql`). Local
     forensic copy via `npx wrangler d1 export DB --remote --output
     incidents/<stamp>/forensic.sql` + `sha256sum`.
   - **Step 4 — rotate Mailgun.** This is the keystone for an
     `MAILGUN_API_KEY` leak; do it before the slower steps to shut down
     the attacker's send capability.
     1. Mailgun dashboard → **Settings → API security → Reset API key**.
     2. `npx wrangler secret put MAILGUN_API_KEY` with the new value
        (run from `apps/worker/`).
     3. Confirm Mailgun-side: a quick `curl -s --user 'api:$NEW_KEY'
        https://api.mailgun.net/v3/domains` returns 200 with the
        domain list.
     4. Confirm Worker-side: trigger one outbound — invitation resend or
        password-reset request from a test account — and check
        `email_logs` for `status = 'sent'`.
   - **Step 2 — lock affected accounts.** No user accounts are
     compromised in this scenario; skip.
   - **Step 3 — rotate `SESSION_SECRET` + wipe sessions.** Not strictly
     required for an isolated Mailgun key leak, but the runbook calls
     for the full S0/S1 set. Decision in the drill: skip
     `DELETE FROM sessions` (no auth surface compromise), but rotate
     `SESSION_SECRET` since rotating costs us nothing and the spec lists
     it as part of the S1 set. **Gap surfaced** — the runbook should
     guide this decision rather than leaving it to discretion (see gaps
     below).
   - **Step 6 — Cloudflare credentials.** Not exposed; skip.
   - **Step 7 — `BOOTSTRAP_SECRET`.** `npx wrangler secret list` —
     confirmed not present. (It's been removed since the initial
     bootstrap, per the deployment runbook.)
4. **Communication.**
   - Customer notification — drafted from the [S0/S1 template](#customer-notification-s0s1--within-24-hours).
     For this scenario the operator stops short of "120 students" and
     uses "no evidence of student-record access; outbound mail capability
     was the exposed surface."
   - Student notification — not triggered. The customer's FERPA officer
     is looped in for awareness, not for outbound notification.
   - Internal — three updates posted at +0h, +1h (post-rotation), and
     close.
5. **Eradicate + recover.**
   - Replace the literal in the test fixture with a clearly-fake value
     (e.g. `key-FAKE-FOR-TESTS-NEVER-REAL`) on a fresh branch and merge
     normally. The leaked value cannot be removed from any clone that
     pulled the bad commit, but the live key has already been reset
     upstream so it is dead weight.
   - Decide on history rewrite: because the bad commit is recent,
     short-lived, and not yet referenced from other branches, walk
     `git filter-repo --replace-text` to scrub the literal across
     history and force-push `main`. Notify all collaborators to re-clone.
     Document the exact command + safety rails in
     [docs/security-ci.md](security-ci.md). For older / referenced
     leaks, prefer leaving the history intact and rely on rotation —
     rewriting shared history breaks every checkout.
6. **Post-incident.**
   - Post-mortem due 2026-05-11.
   - Corrective actions filed (see gaps below).

**Gaps surfaced during the drill** — these go into the follow-up issue:

- **Decision guidance for "rotate SESSION_SECRET" on a non-auth-surface
  S1.** The runbook lists rotation as part of the S1 set without saying
  whether it should fire when the leaked secret is unrelated to the
  session layer. Add a "rotate which secrets" decision matrix keyed off
  the *exposed* secret, not the tier alone.
- **`SESSION_SECRET` is dead weight today.** ~~The Worker doesn't use
  it.~~ Resolved (UNI-37): `SESSION_SECRET` now keys an HMAC-SHA-256
  over the raw session token, so rotating it invalidates every row in
  `sessions` and is a real sign-everyone-out lever for the regular-user
  surface. Parent sessions, MFA challenges, and parent magic-link
  tokens still rely on the `DELETE FROM …` statements; both levers go
  together during S0/S1.
- **`SKIP_SECRET_SCAN=1` was used without an explanation.** ~~The pre-
  commit hook accepts the env-var override silently.~~ Resolved
  (UNI-38): the hook now refuses `SKIP_SECRET_SCAN=1` unless a
  non-empty `SKIP_SECRET_SCAN_REASON=...` is set alongside it, and
  emits a stderr banner with the reason, the user's email, the branch,
  the staged file list, and a best-effort commit subject so every
  bypass is auditable. See `docs/security-ci.md` → "Bypassing the
  hook" for when this is and isn't appropriate.
- **No documented history-rewrite recipe.** The drill walked through
  `git filter-repo --replace-text` by hand and made up the safety rails
  on the spot (re-clone notice, "old + referenced = don't rewrite"
  rule). Codify the exact command + safety rails in
  `docs/security-ci.md → Triage flow when the hook fires`.
- **Incident-directory convention is undefined.** The runbook tells the
  operator to drop forensic artefacts under `incidents/<stamp>/` but
  the top-level `.gitignore` does not exclude it; an inattentive `git
  add` after an incident could check forensic dumps into the repo. Add
  `incidents/` to `.gitignore`.
- **Customer escalation contacts are placeholders.** The operator
  cannot place a real call from this runbook today. Block launch on
  filling in the [Owners and escalation contacts](#owners-and-escalation-contacts)
  table.
- **Mailgun-side reset is dashboard-only.** The runbook should call out
  that the Mailgun reset is point-and-click (no API equivalent), so an
  operator reading this at 3 a.m. doesn't waste time hunting for a CLI.

The drill confirmed the runbook is usable end-to-end for an S1 leak of
`MAILGUN_API_KEY`. None of the surfaced gaps blocked containment; they
are quality-of-runbook improvements rather than missing-control issues.
