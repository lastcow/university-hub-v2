# Disaster recovery

Backup and restore plan for University Hub v2 (sub-issue UNI-27 under the
pre-launch security hardening epic).

| Item                  | Value                                                      |
|-----------------------|------------------------------------------------------------|
| Primary scheduler     | GitHub Actions cron — `.github/workflows/d1-backup.yml`    |
| Defense-in-depth      | Workers Cron Trigger — `apps/worker/wrangler.toml`         |
| Backup window         | Daily at 02:00 UTC (best-effort — both schedulers can drift) |
| Storage               | Cloudflare R2 bucket `university-hub-backups` (default)    |
| Retention             | 30 dailies · 12 weeklies · 6 monthlies                     |
| Encryption at rest    | Cloudflare R2 server-side (AES-256, automatic)             |
| Encryption in transit | TLS — wrangler API + R2 endpoints                          |
| Restore drill cadence | Quarterly, against a scratch D1 (NEVER prod)               |
| Owner                 | *(fill in: ops lead, on-call rotation, escalation contact)* |

This doc is a runbook. If you only need a one-line answer:

> **Where are the backups?** `r2://university-hub-backups/d1/{daily,weekly,monthly}/`.
> **How do I restore?** `node scripts/restore-d1.mjs --target=<scratch-d1> --latest=daily`.
> **What if it didn't run?** Check the GitHub Actions tab → `d1-backup` →
> the latest run. If GH Actions was down, fall back to a manual run from
> any machine with `CLOUDFLARE_API_TOKEN` set.

## Why two schedulers?

Cloudflare D1 backups are not yet a managed Cloudflare service. We run them
ourselves with two independent code paths so a failure in one does not
silently leave you without a backup:

1. **GitHub Actions runner — primary.** Calls `wrangler d1 export DB
   --remote --output=…sql` (CLI-only) and pushes the resulting SQL text
   dump into R2. Format: portable SQL, restorable with
   `wrangler d1 execute DB --file=…sql` against any D1.
2. **Workers Cron Trigger — fallback.** The Worker's `scheduled(...)`
   handler calls `env.DB.dump()` and pushes the resulting SQLite ArrayBuffer
   into R2. Useful if (a) you don't run GitHub Actions, or (b) the runner
   is degraded. `D1.dump()` is not supported on every D1 backend — when
   that happens the scheduled handler logs a structured failure and exits
   2xx so the Worker doesn't go into an alert loop.

Both schedulers write into the same bucket under separate filename
extensions (`*.sql` from the CLI runner, `*.sqlite` from the Worker), so
inspecting an R2 listing tells you which path produced each object.

## R2 layout

```
r2://university-hub-backups/
├── d1/
│   ├── daily/    YYYYMMDDTHHMMSSZ.sql       ← retained 30 days
│   ├── weekly/   YYYYMMDDTHHMMSSZ.sql       ← retained 12 weeks (Sundays only)
│   └── monthly/  YYYYMMDDTHHMMSSZ.sql       ← retained 6 months (1st of month only)
```

Each daily run uploads exactly one file into `daily/`. On Sundays it
*also* uploads a copy into `weekly/`; on the 1st of every month it *also*
uploads a copy into `monthly/`. The same export feeds all three tiers, so
the export step never runs more than once per day.

Retention is enforced two ways:

- **Script-level** — `scripts/backup-d1.mjs` lists each tier after upload
  and deletes anything older than the configured ceiling. This is the
  authoritative gate.
- **R2 lifecycle rule** — belt + suspenders. Configure it once on the
  bucket (see "Provision the R2 bucket" below) so a failed retention
  sweep doesn't silently grow the bucket forever.

## Provision the R2 bucket (one-time)

Run this from any machine with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
exported (or `npx wrangler login` first).

```bash
# 1. Create the bucket. Pick a unique name if you're sharing the account
#    with other deploys.
npx wrangler r2 bucket create university-hub-backups

# 2. (Optional but recommended) Configure lifecycle rules in the dashboard:
#    R2 → university-hub-backups → Settings → Object Lifecycle.
#    Add three rules so untracked / orphaned objects still age out:
#      • prefix d1/daily/   → expire after 35 days   (5-day grace beyond the 30-day script ceiling)
#      • prefix d1/weekly/  → expire after 95 days   (≈13 weeks)
#      • prefix d1/monthly/ → expire after 200 days  (≈6.5 months)
#    The script enforces the tighter ceiling; the lifecycle rule is the
#    safety net if a sweep ever fails to run.
```

Bucket-level encryption is automatic (Cloudflare R2 stores all objects
encrypted with AES-256 at rest). No `--storage-class` configuration is
needed; R2 has a single class.

## Wire up the GitHub Actions cron (one-time)

In the repository settings:

1. **Settings → Secrets and variables → Actions → Secrets:**
   - `CLOUDFLARE_API_TOKEN` — scoped to D1:Read + R2:Edit on the deploy
     account. Create at **Cloudflare → My Profile → API Tokens → Create
     Token → Custom token**.
   - `CLOUDFLARE_ACCOUNT_ID` — the account that owns the D1 + R2 bucket.

2. **Settings → Secrets and variables → Actions → Variables** (optional):
   - `D1_BACKUP_BUCKET` — override the default `university-hub-backups`.
   - `D1_BACKUP_PREFIX` — override the default `d1`.
   - `D1_BACKUP_RETAIN_DAILY` / `D1_BACKUP_RETAIN_WEEKLY` /
     `D1_BACKUP_RETAIN_MONTHLY` — override the 30/12/6 ceilings.

3. The workflow runs daily at 02:00 UTC and on manual dispatch
   (**Actions → d1-backup → Run workflow**). Trigger it once after setup
   to confirm secrets are wired correctly — you'll see the export, three
   uploads (daily + weekly + monthly all on first run), and a retention
   sweep with zero deletions.

## Wire up the Worker Cron Trigger (one-time)

The cron is already declared in `apps/worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * *"]

[[r2_buckets]]
binding = "BACKUPS"
bucket_name = "university-hub-backups"
```

After running `npx wrangler deploy` from `apps/worker/`, the Cron Trigger
will fire on the next 02:00 UTC. Tail it with `npx wrangler tail
university-hub-v2` and look for `[cron:d1-backup] ...` lines. A successful
run logs `ok` with the keys uploaded; a `D1.dump() failed` line is
expected on D1 backends that don't support the legacy dump method — at
that point the GitHub Actions path is your only working backup, which is
exactly why we run two schedulers.

If you don't want the Worker cron at all (e.g. you're confident in
GitHub Actions), comment out the `[triggers]` and `[[r2_buckets]]` blocks
in `wrangler.toml` and redeploy.

## Manual backup (on-demand)

Any time, from any machine with `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`:

```bash
# from the repo root
node scripts/backup-d1.mjs

# dry-run (no upload, no delete) — useful for verifying the dump succeeds
D1_BACKUP_DRY_RUN=1 node scripts/backup-d1.mjs
```

Output is structured JSON at the end; non-zero exit signals failure.

## Restore procedure

> **Hard rule: never restore directly into production.** Restore into a
> scratch D1 first, verify, then promote (either by switching the binding
> in `apps/worker/wrangler.toml` and redeploying the Worker, or by
> exporting from the scratch D1 back into prod).

### 1. Pick a backup

```bash
# List what's available.
npx wrangler r2 object list university-hub-backups --prefix=d1/daily/   --remote
npx wrangler r2 object list university-hub-backups --prefix=d1/weekly/  --remote
npx wrangler r2 object list university-hub-backups --prefix=d1/monthly/ --remote
```

Pick the newest object that pre-dates the data-loss event. If you don't
have a specific timestamp in mind, the latest daily is almost always the
right choice.

### 2. Provision a scratch D1

```bash
npx wrangler d1 create university-hub-v2-scratch
# Note the database_id printed by the command.
```

### 3. Restore into the scratch D1

```bash
# Newest daily backup, automatically resolved.
node scripts/restore-d1.mjs --target=university-hub-v2-scratch --latest=daily

# Or pick a specific object.
node scripts/restore-d1.mjs \
  --target=university-hub-v2-scratch \
  --key=d1/daily/20260504T020000Z.sql
```

The script downloads the dump, captures pre-restore row counts on the
scratch DB (typically all zeros for an empty scratch), runs
`wrangler d1 execute --file=…sql`, then captures post-restore row counts
and prints a side-by-side diff. Confirm the post-restore counts match
your expectations (compare against the production counts you captured
*before* the data-loss event, if you have them).

### 4. Verify the restored copy

Bind the scratch DB to a throwaway Worker preview:

```bash
# In a temp branch:
sed -i 's/database_id = "1c19aaa3-dbf6-4159-be4e-7fc89fb00752"/database_id = "<scratch-id>"/' \
  apps/worker/wrangler.toml

cd apps/worker && npx wrangler deploy --name=university-hub-v2-restore-check
```

Sign in as the bootstrapped super_admin against the restore-check Worker
URL and walk the dashboard, audit logs, email logs, and a few user /
course pages. If all looks right, proceed to step 5.

### 5. Promote (only if you really need to overwrite prod)

The intended pattern is to fix the issue inside the scratch DB if
possible, then export *from the scratch DB* and re-import into a fresh
prod D1, rather than overwrite prod in place. If you absolutely must
overwrite prod:

```bash
# Final — irreversible — overwrite. The script refuses without the
# explicit ack flag.
node scripts/restore-d1.mjs \
  --target=university-hub-v2 \
  --key=d1/daily/20260504T020000Z.sql \
  --i-understand-this-overwrites-prod
```

Then redeploy the Worker (no code change needed; the binding still
points at `university-hub-v2`):

```bash
cd apps/worker && npx wrangler deploy
```

### 6. Tear down

```bash
# When you're satisfied prod is healthy.
npx wrangler delete --name=university-hub-v2-restore-check
npx wrangler d1 delete university-hub-v2-scratch
```

## Recovery point objective (RPO) and recovery time objective (RTO)

| Metric | Target                                                                  |
|--------|-------------------------------------------------------------------------|
| RPO    | ≤ 24h. Worst-case data loss is the day's writes since the last 02:00 UTC backup. |
| RTO    | ≤ 1 hour. Pulling a daily dump from R2 + `wrangler d1 execute --file=…` is on the order of minutes for the current schema; the bulk of RTO is operator decision-making. |

If a tighter RPO is needed for a specific customer, two paths:

- **Increase frequency.** Add a second cron entry to `wrangler.toml`
  and/or a second `schedule:` clause in the GitHub Actions workflow.
  Keep an eye on R2 storage cost — a 2-hour cadence at the same retention
  ceilings is 12× the daily cost.
- **Investigate Cloudflare D1 native backups.** Cloudflare has shipped
  managed D1 backups in the past (point-in-time recovery on a 30-day
  window). When that returns to the GA surface area, prefer it over
  this homegrown path. Until then, this runbook is the source of truth.

## Restore drill — runbook

Run this **at minimum quarterly**, and again whenever the schema changes
in a way that could affect restoration (rename of a NOT NULL column,
addition of a CHECK constraint, etc.). The drill is the only way to know
whether the backups are actually usable.

1. Pick the latest daily from R2 (no spelunking needed — the script
   resolves it).
2. Provision a scratch D1 (`wrangler d1 create university-hub-v2-drill`).
3. Run `node scripts/restore-d1.mjs --target=university-hub-v2-drill --latest=daily`.
4. Capture the script's row-count comparison output. The "after" column
   should be non-zero on every table that's non-empty in prod.
5. Sign in via a throwaway Worker bound to the drill DB and walk a
   handful of admin pages.
6. Tear down (`wrangler d1 delete university-hub-v2-drill`).
7. Update this doc's "Last drill" line below with the date + the row
   counts you captured. If anything broke, open a follow-up issue and
   include the script output verbatim.

### Last drill

| Date       | Tier  | Source                                                       | Outcome |
|------------|-------|--------------------------------------------------------------|---------|
| 2026-05-04 | local | `migrations/0001…0006` + `0003_seed_dev_data.sql` (dev seed) | PASS    |

#### Initial drill (UNI-27)

The first drill of this runbook was performed against a local SQLite
backed by `wrangler --local` rather than a remote scratch D1
(production wasn't yet provisioned per the security epic timeline). The
flow exercised was identical to the remote restore steps above:

1. Apply `migrations/0001…0006` (which include `0003_seed_dev_data.sql`)
   to a fresh local D1 to reach a known starting state.
2. Run `wrangler d1 export DB --local --output=drill.sql`.
3. Wipe the local state (`rm -rf apps/worker/.wrangler`) so the next
   `wrangler d1 execute --local` runs against an empty database — the
   stand-in for the freshly provisioned scratch D1 in the remote flow.
4. Run `wrangler d1 execute DB --local --file=drill.sql`.
5. Capture row counts on the restored DB and diff against the pre-export
   snapshot.

Row counts (every table from `sqlite_master` except `sqlite_*` and
`_cf_*` housekeeping):

| table               | before | after | delta |
|---------------------|-------:|------:|------:|
| audit_logs          |      0 |     0 |     0 |
| courses             |      3 |     3 |     0 |
| d1_migrations       |      6 |     6 |     0 |
| departments         |      2 |     2 |     0 |
| email_logs          |      0 |     0 |     0 |
| faculty             |      1 |     1 |     0 |
| invitations         |      0 |     0 |     0 |
| mfa_challenges      |      0 |     0 |     0 |
| rate_limit_counters |      0 |     0 |     0 |
| sessions            |      0 |     0 |     0 |
| students            |      1 |     1 |     0 |
| teacher_assistants  |      1 |     1 |     0 |
| teachers            |      1 |     1 |     0 |
| universities        |      1 |     1 |     0 |
| users               |      9 |     9 |     0 |

All deltas zero — the dump is faithful and `wrangler d1 execute --file`
recreates the schema + seed data as expected. A spot-check on `users`
confirmed every dev-seed role (`super_admin`, `university_admin`,
`staff`, `faculty`, `teacher`, `teacher_assistant`, `student`, `guest`,
`viewer`) round-tripped with the right `email` / `role` / `status`.

When production is provisioned, the next drill should be remote
(`--remote` instead of `--local`) and recorded here with the
production-tier row counts redacted to category totals (counts of
universities / users / courses / sessions are fine; PII is not).

## Production data was lost — what now?

Symptom triage:

- **A specific row is wrong but most of the DB is fine.** This is a
  surgical fix, not a restore. Use `wrangler d1 execute` with a targeted
  `UPDATE` statement, or write a one-off compensating migration. Restore
  is too blunt for this.
- **A table was dropped or wholesale corrupted.** Restore the latest
  daily into a scratch D1 (steps 1–3 above), `wrangler d1 export
  --remote` just that table, and import it into prod with a `DELETE
  FROM <table>; ` followed by the imported `INSERT`s wrapped in a
  transaction.
- **The whole database is unusable / a destructive migration was
  applied.** Full restore — steps 1–6 above. Communicate to the
  customer that data written between the last 02:00 UTC backup and the
  incident may be lost; your RPO is 24h.

In all cases:

1. Snapshot the broken-but-current prod first (`scripts/backup-d1.mjs`
   on-demand) — this becomes the "incident DB" you can examine offline
   later.
2. Notify the customer per the incident-response runbook
   ([docs/incident-response.md](incident-response.md)) if the impact
   warrants it.
3. After recovery, file a post-mortem issue and add a regression check
   if the root cause is reproducible (e.g. a migration smoke test).

## Out of scope

- **Multi-region replication.** Cloudflare D1 doesn't expose this for
  customer use yet. R2 itself is multi-region by default for object
  durability, so backups remain available even if a region degrades.
- **Point-in-time recovery beyond what Cloudflare's underlying
  snapshots provide.** Our RPO ceiling is 24h. Customers who need
  finer-grained recovery should layer their own application-level
  audit + replay (e.g. event sourcing for grades — out of scope for
  this hardening pass).
- **Cross-customer backup orchestration.** Each customer deployment
  backs itself up. There is no central "backup-all-customers" job; the
  per-customer GitHub Actions workflow + R2 bucket is the unit.
