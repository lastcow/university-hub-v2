# Per-customer provisioning

End-to-end walkthrough for spinning up a brand-new customer university on
University Hub (sub-issue UNI-28). Single-tenant per university is the
deployment model — one Cloudflare Worker, one D1 database, one Pages
project per customer. This script is how it scales.

If you want the broader Cloudflare deploy walkthrough (the very first ship
of the codebase, before there are any customers), see
[`docs/deployment.md`](deployment.md). This doc is the customer-by-customer
flow that runs on top of that initial setup.

## What gets created

For an input slug `acme`:

| Resource          | Cloudflare name                  | Purpose                           |
|-------------------|----------------------------------|-----------------------------------|
| D1 database       | `university-hub-acme`            | Tenant data — users, sessions, …  |
| Worker            | `university-hub-acme`            | Serves `/api/*` for this tenant   |
| Pages project     | `university-hub-acme-web`        | Tenant SPA                        |
| Per-tenant config | `provisioning/acme/wrangler.toml`| Inputs to `wrangler deploy`       |

Default URLs (no custom domain):

- SPA: `https://university-hub-acme-web.pages.dev/`
- API: `https://university-hub-acme.<your-account>.workers.dev/`

Workspace `provisioning/` is gitignored — generated tenant configs hold the
D1 `database_id`, which is a Cloudflare resource identifier (not a secret,
but not interesting to commit either).

## Prerequisites

- The base codebase is already deployed once per
  [`docs/deployment.md`](deployment.md) — the script reuses the same
  Worker code, the same `migrations/` files, and the same Mailgun template
  set, just pointed at per-tenant resources.
- Cloudflare account with Workers, Pages, and D1 enabled. The free plan is
  fine for a small university; the script does not require R2.
- An API token with at least the following scopes (Account-level):
  - **Workers Scripts: Edit**
  - **Workers KV Storage: Edit** (covers secrets)
  - **D1: Edit**
  - **Cloudflare Pages: Edit**
  - **Account Settings: Read** (for the workers.dev subdomain lookup)
  - **Account Filter: Read** (for listing existing resources)
- Node.js >= 20 and the repo checked out locally with dependencies
  installed (`npm install` from the repo root).
- Two environment variables exported in your shell:

  ```bash
  export CLOUDFLARE_API_TOKEN=...        # the token described above
  export CLOUDFLARE_ACCOUNT_ID=...       # the account that hosts every tenant
  ```

- A production base domain (optional). If your SaaS issues subdomains under
  e.g. `universityhub.io`, the customer slug becomes
  `<slug>.universityhub.io`. If a customer brings their own domain
  (`hub.acme.edu`), pass `--custom-domain=hub.acme.edu` instead.

## Inputs

```text
--name="Acme University"             required  Display name (ends up in University.name + emails)
--slug=acme                          required  DNS-safe identifier; also the resource name suffix
--admin-email=admin@acme.edu         required  Bootstrap super_admin email
--admin-name="Site Admin"            required  Bootstrap super_admin display name

--custom-domain=hub.acme.edu         optional  Attach a Pages custom domain
--app-base-url=https://hub.acme.edu  optional  Override APP_BASE_URL (used in email links).
                                                Defaults to the custom domain, else the
                                                pages.dev URL.

--mailgun-api-key=...                optional  If supplied, all four primary Mailgun flags must
--mailgun-domain=mg.acme.edu                   come together. Otherwise the script leaves
--mailgun-from-email=no-reply@...              MAILGUN_* unset and you can either reuse the
--mailgun-from-name="Acme University"          SaaS-level Mailgun account by setting them later
--mailgun-region=US|EU               optional  via `wrangler secret put …` against the per-tenant
                                                config, or skip Mailgun entirely (Settings UI
                                                will display "Missing configuration").
--support-email=support@acme.edu     optional  Sets SUPPORT_EMAIL.

--password-env=ADMIN_PASSWORD        optional  Env var holding the bootstrap admin password.
                                                If omitted the script generates a random 16-char
                                                temporary password and prints it once at the end.

--skip-bootstrap                     optional  Provision everything but skip the super_admin
                                                bootstrap (e.g. if the customer wants to
                                                bootstrap interactively later).
--skip-pages-deploy                  optional  Create the Pages project but skip building +
                                                uploading the SPA (useful if Pages is wired up
                                                via the GitHub integration instead).
--dry-run                            optional  Print what would change; make no API calls
                                                that mutate state (other than the D1 list
                                                lookup).
```

Slug validation: lowercase letters/digits/hyphens, 3–32 characters, no
leading/trailing hyphen, no `--`. Reserved names (`api`, `admin`, `app`,
`www`, `support`, `university-hub-v2`, …) are rejected up front so a
customer can never collide with the SaaS-level routes.

## Walkthrough

### 1. Run the provision script

From the repo root:

```bash
npm run provision:university -- \
  --name="Acme University" \
  --slug=acme \
  --admin-email=admin@acme.edu \
  --admin-name="Site Admin" \
  --custom-domain=hub.acme.edu \
  --mailgun-api-key="$ACME_MAILGUN_KEY" \
  --mailgun-domain=mg.acme.edu \
  --mailgun-from-email=no-reply@mg.acme.edu \
  --mailgun-from-name="Acme University" \
  --support-email=support@acme.edu
```

What runs:

1. Resolve the account's `*.workers.dev` subdomain so we can compute the
   Worker URL.
2. **D1**: look up `university-hub-acme`. Create it if missing. Record the
   `database_id`.
3. Render `provisioning/acme/wrangler.toml` from the template (worker
   name, db id, app base URL, allowed origins). This file is the per-tenant
   `--config=` for every subsequent `wrangler` call.
4. **Migrations**: stage every `migrations/*.sql` *except*
   `0003_seed_dev_data.sql` into a temp dir, point a transient wrangler
   config at it, and run `wrangler d1 migrations apply DB --remote`. The
   dev seed is never applied to a customer instance (no
   `superadmin@dev.local` in production).
5. **Worker**: `wrangler deploy --config=provisioning/acme/wrangler.toml`.
6. **Secrets**: set `SESSION_SECRET` (fresh random), `APP_BASE_URL`,
   `ALLOWED_WEB_ORIGINS`, the four Mailgun secrets if supplied,
   `SUPPORT_EMAIL` if supplied.
7. **Pages**: create `university-hub-acme-web` if missing, then
   `npm run build` with `VITE_API_BASE_URL` pointed at the new Worker, and
   `wrangler pages deploy` the resulting `apps/web/dist`.
8. If `--custom-domain` was given, attach the Pages custom domain via the
   Cloudflare API. The script prints the CNAME value the operator needs to
   create at the customer's DNS.
9. **Bootstrap**: if no `super_admin` row exists yet on the new D1, mint a
   `BOOTSTRAP_SECRET`, post to `/api/bootstrap/super-admin`, then delete the
   secret. The temp password is generated and printed on the final line; if
   `--password-env` was set, that env var is used instead and the password
   is never echoed.

The summary block at the end lists every URL, the tenant config path, and
(if generated) the one-time admin password.

### 2. DNS for a custom domain

If you passed `--custom-domain=hub.acme.edu`, the customer (or whoever
owns that DNS zone) needs to add:

```
hub.acme.edu.   IN CNAME   university-hub-acme-web.pages.dev.
```

Cloudflare provisions the certificate within a few minutes once DNS
resolves. Until that happens, the SPA stays reachable on the default
`https://university-hub-acme-web.pages.dev/` URL.

The Worker keeps its `*.workers.dev` URL in this round. Adding a
`api.hub.acme.edu` Worker custom domain is an out-of-band step: in the
Cloudflare dashboard, **Workers → `university-hub-acme` → Triggers →
Custom Domains → Add Custom Domain → `api.hub.acme.edu`**. After that, set
`VITE_API_BASE_URL` on the Pages project to the new origin and re-run the
Pages deploy. (See [`docs/deployment.md` → "Custom domains"](deployment.md#custom-domains-future-step) for the longer story.)

### 3. Verify the new deployment

Smoke checks that take 60 seconds and catch the obvious failures:

- `curl -i https://university-hub-acme.<account>.workers.dev/api/health` → `200`.
- `curl -i https://university-hub-acme-web.pages.dev/` → `200`, returns SPA HTML.
- Sign in at `https://university-hub-acme-web.pages.dev/sign-in` with the
  bootstrapped admin email + temp password. You should land on
  `/app/dashboard`.
- `wrangler secret list --name=university-hub-acme --config=provisioning/acme/wrangler.toml`
  shows `SESSION_SECRET`, `APP_BASE_URL`, `ALLOWED_WEB_ORIGINS`,
  the four Mailgun secrets if you set them, and **no `BOOTSTRAP_SECRET`**.
- `wrangler d1 execute university-hub-acme --remote --command="SELECT email, role FROM users"`
  returns exactly one row: the admin you created.

If Mailgun was configured, send yourself a test invitation through the new
admin's `/app/invitations` page; confirm the email arrives and the
`{{app_base_url}}` in the link points at the right origin.

## Re-running the script

The script is idempotent. Re-running with the same `--slug` does not
recreate anything that already exists:

| Step                | Behavior on re-run                                                    |
|---------------------|-----------------------------------------------------------------------|
| D1 database         | Detected via `wrangler d1 list`, skipped if present.                  |
| Tenant `wrangler.toml` | Re-rendered. Safe — same inputs produce the same file.             |
| Migrations          | `wrangler d1 migrations apply` is wrangler's no-op when up to date.   |
| Worker deploy       | Always re-deploys (cheap; identical bundle = no-op at the edge).      |
| `SESSION_SECRET`    | **Set only on the first run.** Re-runs leave the existing value alone so live sessions are not invalidated. To rotate intentionally, run `wrangler secret put SESSION_SECRET --config=provisioning/<slug>/wrangler.toml`. |
| `APP_BASE_URL` / `ALLOWED_WEB_ORIGINS` / Mailgun secrets | Re-set on every run with the supplied values. Pure overrides — no destructive side effect. Useful for fixing one of them after the fact. |
| Pages project       | Detected via API; skipped if present.                                 |
| Pages deploy        | Always re-deploys.                                                    |
| Custom domain       | POST `pages/projects/:p/domains`; "already exists" is treated as success. |
| Bootstrap           | Skipped if a `super_admin` row already exists on the new D1.          |

## Bringing in a new operator

If a different person needs to operate an existing tenant (e.g. a colleague
takes over `acme`), they can re-create their local toolchain from the
committed sources:

```bash
git clone <this repo>
npm install
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
# Re-render the tenant config without changing anything live:
node scripts/provision-university.mjs \
  --name="Acme University" --slug=acme \
  --admin-email=admin@acme.edu --admin-name="Site Admin" \
  --skip-bootstrap --skip-pages-deploy --dry-run
```

The dry-run prints every step the script would take and writes
`provisioning/acme/wrangler.toml` to disk. Drop `--dry-run` to apply
incremental changes (e.g. `--mailgun-api-key=…` to populate Mailgun later).

## Decommissioning

When a customer leaves, run the companion teardown script:

```bash
# Dry run first — prints what would be deleted, makes no API calls that mutate.
npm run decommission:university -- --slug=acme

# Apply.
npm run decommission:university -- --slug=acme --confirm
```

What it removes (in order, so the SPA goes dark first and data is the
last to drop in case you want to back up):

1. Pages project `university-hub-acme-web` (and every deployment under it).
2. Worker `university-hub-acme` (revoking every secret in the process).
3. D1 database `university-hub-acme` — **destructive, no undo**.
4. The `provisioning/acme/` directory on disk.

Custom-domain DNS records at the customer's zone are not touched — the
operator still needs to delete the CNAME (or repoint it).

## Rollback

If the script fails partway through, the safest path is:

1. Read the final error message; the failing step is named.
2. Run `npm run decommission:university -- --slug=<slug>` to dry-run the
   teardown and confirm what's already on the account.
3. Either re-run the provision script (idempotent — it'll fill in what's
   missing) or run `decommission` with `--confirm` to remove everything
   and start fresh.

A failed bootstrap call is a partial failure: the `BOOTSTRAP_SECRET` is
deleted automatically (best-effort), and the next re-run will see no
`super_admin` row and try again. If `wrangler secret delete` itself fails
(network blip), remove the secret manually:

```bash
wrangler secret delete BOOTSTRAP_SECRET \
  --name=university-hub-<slug> \
  --config=provisioning/<slug>/wrangler.toml
```

## Out of scope (for this script)

- Billing / metering integration. Each customer is invoiced manually until
  there's a SaaS-level dashboard.
- A SaaS admin UI to manage customer instances. CLI only this round; the
  full set of operations (provision, decommission, list) live in
  `scripts/`.
- Migration to a fully container-orchestrated provisioning runtime
  (k8s / nomad). Cloudflare-native is the platform.
- D1 backups for the tenant — the GitHub Actions workflow at
  `.github/workflows/d1-backup.yml` is hard-coded to `university-hub-v2`
  today; once the SaaS-level backup story is fleshed out (UNI-36 follow-up
  step), tenant backups will be configured per-customer.
