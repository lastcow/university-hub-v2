# Data retention

Retention schedule and automated archival for University Hub v2 (sub-issue
UNI-33 under the pre-launch security hardening epic).

| Item              | Value                                                                |
|-------------------|----------------------------------------------------------------------|
| Compliance regime | FERPA (US universities). GDPR / CCPA explicitly out of scope.        |
| Cron schedule     | Nightly at 02:30 UTC — `apps/worker/wrangler.toml` `[triggers]`.     |
| Implementation    | `apps/worker/src/services/retention.ts`                              |
| Per-customer override | Cloudflare env vars (`RETENTION_*`) — see [Per-customer overrides](#per-customer-overrides). |
| Owner             | *(fill in: ops lead, escalation contact)*                            |

This doc is the contract between the code and what each customer is told
about retention. If a row in this table changes, the corresponding default
in `apps/worker/src/services/retention.ts` MUST change with it (and vice
versa); the test suite asserts the defaults.

## TL;DR

| Table | Action | Default window | Then | Override env var |
|-------|--------|----------------|------|------------------|
| `grades` | archive | 7 years (since `updated_at`) | retain in `archived_grades` indefinitely | `RETENTION_EDUCATIONAL_DAYS` |
| `assessments` | archive | 7 years (since `updated_at`) | retain in `archived_assessments` indefinitely | `RETENTION_EDUCATIONAL_DAYS` |
| `assessments` (soft-deleted) | archive early | 1 year (since `deleted_at`) | retain in `archived_assessments` indefinitely | `RETENTION_SOFT_DELETED_DAYS` |
| `course_assignments` | archive | 7 years (since `updated_at`) | retain in `archived_course_assignments` indefinitely | `RETENTION_EDUCATIONAL_DAYS` |
| `audit_logs` | archive | 7 years (since `created_at`) | retain in `archived_audit_logs` indefinitely | `RETENTION_AUDIT_LOG_DAYS` |
| `grade_access_log` | archive | 7 years (since `accessed_at`) | retain in `archived_grade_access_log` indefinitely | `RETENTION_GRADE_ACCESS_LOG_DAYS` |
| `email_logs` | archive | 90 days (since `created_at`) | purge from `archived_email_logs` after 1 year | `RETENTION_EMAIL_LOG_DAYS` / `RETENTION_ARCHIVE_EMAIL_DAYS` |
| `sessions` | purge | 30 days past `expires_at` | — | `RETENTION_SESSION_PURGE_DAYS` |
| `rate_limit_counters` | purge | 30 days past `expires_at` (ms) | — | `RETENTION_RATE_LIMIT_PURGE_DAYS` |
| `mfa_challenges` | purge | 30 days past `expires_at` | — | `RETENTION_MFA_CHALLENGE_PURGE_DAYS` |
| `parent_sign_in_tokens` | purge | 30 days past `expires_at` | — | `RETENTION_PARENT_TOKEN_PURGE_DAYS` |
| `parent_sessions` | purge | 30 days past `expires_at` | — | `RETENTION_PARENT_SESSION_PURGE_DAYS` |

## Decisions and why

### Educational records (grades, assessments, course_assignments) — 7 years, archived

| Decision | Source |
|----------|--------|
| Retention window: 7 years | FERPA does not set a federal floor; institutions decide. 7 years is the most common state-level retention norm and matches the audit-log floor. |
| Behaviour: archive (not delete) | Sub-issue UNI-33 spec: "archive — not delete — to a separate `archived_*` shadow table". Lets a later legal / accreditation request still surface the row without rebuilding from a backup. |
| Anchor column: `updated_at` | We don't track graduation per se. `updated_at` is the row's most-recent mutation; once the student stops being graded, `updated_at` freezes. The 7y clock starts ticking from then. Closest defensible proxy without adding new schema. |
| Override env: `RETENTION_EDUCATIONAL_DAYS` | A graduate institution that retains transcripts longer (15y, 25y) flips this. |

### Audit logs — 7 years, archived

| Decision | Source |
|----------|--------|
| Retention window: 7 years | FERPA implicit minimum: a record-of-access must outlast the record. Matches the educational-records ceiling. |
| Behaviour: archive | Operational audit logs are non-FERPA-required but high-value for incident response. Move to `archived_audit_logs` rather than purge so they survive a compromise of the live DB. |
| Anchor column: `created_at` | Audit log rows are immutable, so `created_at` is unambiguous. |
| Override env: `RETENTION_AUDIT_LOG_DAYS` | A customer with stricter audit retention (state archive, legal hold) raises this. |

### Grade-access log (FERPA §99.32) — 7 years, archived

| Decision | Source |
|----------|--------|
| Retention window: 7 years | FERPA §99.32 requires the institution keep a record of disclosure for as long as the underlying record is kept. Since educational records are 7y, the record-of-access matches. |
| Behaviour: archive | Same rationale as audit logs. |
| Anchor column: `accessed_at` | The disclosure event is what FERPA cares about. |
| Override env: `RETENTION_GRADE_ACCESS_LOG_DAYS` | Mirrors the educational override. |

### Email logs — 90 days, archived; archive purges after 1 year

| Decision | Source |
|----------|--------|
| Retention window: 90 days | Operational only — the email-logs admin page exists for ops (delivery debugging, complaint investigation). 90 days is well past Mailgun's own retention ceiling so reconciliation against the upstream is no longer possible. |
| Behaviour: archive (90 days), then purge from archive (1 year) | Sub-issue UNI-33 spec: "archived emails purged after a year". |
| Anchor columns: `created_at` (live), `retention_archived_at` (archive) | The live anchor is the email send time; the archive anchor is the moment of archival, since that's when the operational lifecycle ends. |
| Override envs: `RETENTION_EMAIL_LOG_DAYS`, `RETENTION_ARCHIVE_EMAIL_DAYS` | A customer with weaker / stronger ops needs flips both. |

### Sessions / rate-limit counters / MFA challenges / parent tokens / parent sessions — 30 days, purged

| Decision | Source |
|----------|--------|
| Retention window: 30 days past `expires_at` | Sub-issue UNI-33 spec ("Sessions: purge entries with `expires_at < now() - 30 days`"; "Failed sign-in / rate-limit counters: purge after 30 days"). The 30-day grace is so a row that just expired this minute isn't immediately reaped — useful for forensic correlation with audit logs in the immediate aftermath of an incident. |
| Behaviour: purge | These are short-lived, low-value-after-expiry, and cheap to regenerate. Archiving them would leak hashes (token_hash columns) past their useful life for no benefit. |

### Soft-deleted assessments (`deleted_at IS NOT NULL`) — 1 year, archived

| Decision | Source |
|----------|--------|
| Retention window: 1 year past `deleted_at` | Sub-issue UNI-33 spec ("Soft-deleted rows … purged to archive after 1 year unless audit-relevant"). |
| Behaviour: archive (early) | A soft-deleted row is already a tombstone in the live table. Promoting it to the archive sooner keeps the live `assessments` table from accumulating tombstones; the 7y educational sweep still catches anything we missed. |
| Override env: `RETENTION_SOFT_DELETED_DAYS` | If a customer keeps soft-deleted assessments visible in admin tooling for 2 years, raise this. |

## Cron + dispatch

The retention sweep runs from a Cloudflare Cron Trigger declared in
`apps/worker/wrangler.toml`:

```toml
[triggers]
crons = ["30 2 * * *"]
```

The Worker's `scheduled(...)` handler in `apps/worker/src/index.ts`
dispatches by `event.cron`:

- `30 2 * * *` → `runScheduledRetention(env)`.
- `0 2 * * *`  → `runScheduledBackup(env)` (UNI-27, currently disabled
  pending the R2 enablement tracked in [UNI-36](mention://issue/49f17ea4-57e7-43c9-8590-4fb83e48a59b)).

The retention cron is independent of the backup cron — by design, per the
sub-issue spec ("separate from the backup cron in sub-issue 6"). When the
backup is re-enabled, append `"0 2 * * *"` to the `crons` array; the
dispatch handler routes both correctly.

## Per-customer overrides

Every retention window is overridable via an env var. The defaults match
the table at the top of this doc; setting an env var to a positive integer
overrides it for that customer's deployment. Set to a non-numeric or zero
value to fall back to the default.

```text
RETENTION_DRY_RUN=1                          # log the plan without applying
RETENTION_EDUCATIONAL_DAYS=2555              # ~7y, grades + assessments + course_assignments
RETENTION_AUDIT_LOG_DAYS=2555
RETENTION_GRADE_ACCESS_LOG_DAYS=2555
RETENTION_EMAIL_LOG_DAYS=90
RETENTION_SOFT_DELETED_DAYS=365
RETENTION_SESSION_PURGE_DAYS=30
RETENTION_RATE_LIMIT_PURGE_DAYS=30
RETENTION_MFA_CHALLENGE_PURGE_DAYS=30
RETENTION_PARENT_TOKEN_PURGE_DAYS=30
RETENTION_PARENT_SESSION_PURGE_DAYS=30

# Ultimate-retention windows on the archive shadow tables. Email purges
# from archive after 1y by default; the rest are "never auto-purge" until
# the corresponding env var is set to a positive number.
RETENTION_ARCHIVE_EMAIL_DAYS=365
RETENTION_ARCHIVE_AUDIT_LOG_DAYS=
RETENTION_ARCHIVE_GRADE_ACCESS_LOG_DAYS=
RETENTION_ARCHIVE_GRADES_DAYS=
RETENTION_ARCHIVE_ASSESSMENTS_DAYS=
RETENTION_ARCHIVE_COURSE_ASSIGNMENTS_DAYS=
```

Set them as Worker `[vars]` in the customer's deployment of
`wrangler.toml`, or as secrets via `wrangler secret put` if the customer's
retention policy is not something you want in the public repo. The
provisioning script in `provisioning/` reads these from the per-customer
config file when stamping out a new deployment.

### Dry run

`RETENTION_DRY_RUN=1` is the safe first deploy. The Worker logs what
*would* be archived / purged via `wrangler tail` without changing any
rows. Once the operator is satisfied, unset the var and the next nightly
run goes live.

## Operational visibility

Every nightly run logs a structured line:

```text
[cron:retention] ok {"ok":true,"duration_ms":34,"dry_run":false,"now":"2026-05-04T02:30:00.000Z","steps":[{"name":"educational_grades","source_table":"grades","archive_table":"archived_grades","cutoff":"2019-04-08T...","archived":3,"purged":3,"config":{"days":2555,"skipped":false}}, ...]}
```

`wrangler tail university-hub-v2` surfaces these in real time. For
historical inspection, every step's `archived` / `purged` counters can be
exported to a customer's monitoring stack via the Worker's built-in
analytics — set up a tail consumer that filters on the `[cron:retention]`
prefix and forwards the JSON payload.

A step that fails records `error: "<message>"` in its slot but does NOT
abort the whole sweep. The top-level `ok: false` flags a partial run.

## Acceptance test

Reproduces the issue's "Test seed: insert rows backdated past their
retention window; cron run moves them to archive / purges them" line:

```sh
# 1. Seed two rows: one inside the window, one past it (7y + 1d).
wrangler d1 execute DB --remote --command="\
  INSERT INTO grades (id, assessment_id, student_user_id, status, created_at, updated_at) \
  VALUES \
    ('11111111-1111-1111-1111-111111111111','...','...','graded','2018-01-01T00:00:00Z','2018-01-01T00:00:00Z'), \
    ('22222222-2222-2222-2222-222222222222','...','...','graded','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');"

# 2. Trigger the retention cron manually.
wrangler triggers schedule "30 2 * * *"
# (or wait for 02:30 UTC)

# 3. Verify the move.
wrangler d1 execute DB --remote --command="SELECT id FROM grades; SELECT id FROM archived_grades;"
# Expected:
#   grades            -> only 22222222-...
#   archived_grades   -> only 11111111-...
```

## Out of scope

Tracked but explicitly NOT part of this sub-issue, and surfaced here so
the next reviewer knows where the boundary is:

- **Right-to-erasure flow.** No GDPR scope per the security model. If a
  customer needs erasure on demand, build a tooling-level helper that
  hard-deletes a single user's rows across both live and archive tables
  and writes a `disclosure_log` entry recording the erasure action.
- **Per-student retention overrides** (litigation hold, transfer
  freeze, etc.). The current sweep is global per-table, with no per-row
  exclusion. When this need lands, add a `retention_hold_until` column to
  the source tables and exclude `now() < retention_hold_until` from the
  cutoff.
- **Encrypted off-site archive escrow.** R2 with lifecycle is sufficient
  for now. A separate decision will determine whether high-value archive
  rows mirror to a customer-controlled bucket.
- **Soft-deleted courses / departments.** Neither table has a
  `deleted_at` column today. Once one is added (e.g. as part of a future
  course-archival admin feature), extend the retention service with the
  matching step + archive table; the schema follows the same pattern as
  `assessments`.
- **`disclosure_consents` / `disclosure_log` retention.** These are
  FERPA §99.30 / §99.32 surfaces and must be retained as long as the
  educational record they cover. The current sweep does not touch them;
  they remain indefinitely. Revisit when the educational records the
  consents reference start being archived in volume.
- **`contact_messages`** (public-site contact form). Operational; no
  user-supplied retention requirement. Skip until a customer asks.
- **Idempotent batching.** Each step issues two DML statements. For
  pre-launch volumes this is fine; once a customer accumulates millions
  of rows in any one table, we will switch to a paged loop. The result
  envelope surfaces row counts so the operator can spot a step that is
  consistently moving large batches.
