# University Hub v2

A SaaS-style university management platform built on Cloudflare infrastructure
(Workers + D1 + Pages) with Mailgun-powered transactional email. Public
marketing pages, invitation-only sign-up, role-based dashboards for
administrators, faculty, teachers, students, TAs, and guests.

The canonical product spec is the [UNI-1 epic](docs/) — this README is the
day-to-day operator handbook.

## Tech stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui, deployed
  to Cloudflare Pages (project `university-hub-v2-web`).
- **Backend:** Cloudflare Workers + TypeScript, deployed as `university-hub-v2`.
  No framework — a single `fetch()` handler routes `/api/*` paths. The Worker
  is API-only; anything outside `/api/*` returns a JSON 404.
- **Database:** Cloudflare D1 (SQLite) via `env.DB`. SQL migrations under
  `migrations/` at the repo root, applied with `wrangler d1 migrations apply`.
- **Email:** Mailgun. Template HTML is canonical in this repo under
  `mailgun_templates/` and pushed to the Mailgun account by
  `npm run sync:mailgun-templates`. The Worker only ships template name +
  variables — never raw HTML.
- **Auth:** Email + password, PBKDF2-SHA256 hashing via Web Crypto, SHA-256
  hashed session tokens. HttpOnly cookies, `SameSite=None; Secure` in
  production (cross-site SPA → API), `SameSite=Lax` in dev.
- **Package manager:** **npm** (npm workspaces).
- **Node:** >= 20.

## Repository layout

```
university-hub-v2/
  apps/
    web/                       # React + Vite frontend
      src/
        components/
        pages/
        api-client/
      vite.config.ts
      tailwind.config.ts
    worker/                    # Cloudflare Worker backend
      src/
        index.ts               # fetch entrypoint + router
        env.ts                 # Env bindings + secret types
        auth/                  # password, session, invitation token modules
        db/                    # tiny typed wrapper around env.DB
        middleware/            # auth context builder
        mail/                  # Mailgun service + email_logs writer
        routes/                # request handlers (one file per resource)
        services/              # cross-cutting writers (audit logs, ...)
        utils/                 # cookies, JSON responses
      test/                    # vitest unit + route tests
      wrangler.toml
  packages/
    shared/                    # types, zod schemas, role/RBAC constants
  migrations/
    0001_initial_schema.sql    # core tables + indexes (users, sessions, ...)
    0002_email_logs.sql        # email delivery log
    0003_seed_dev_data.sql     # dev super_admin + one user per role
  docs/
    auth.md                    # auth flow, RBAC matrix, invitation lifecycle
    database.md                # schema rationale, migrations, password hashing
    deployment.md              # full Cloudflare deploy walkthrough
    mailgun.md                 # template names, variables, account setup
    security-ci.md             # dependency scanning + SAST gates (UNI-29)
  mailgun_templates/           # canonical Mailgun template HTML + plaintext + meta
  scripts/
    bootstrap-admin.mjs            # production: create the first super_admin
    hash-password.mjs              # offline PBKDF2-SHA256 hash generator
    sync-mailgun-templates.mjs     # push mailgun_templates/ to the Mailgun account
    backup-d1.mjs                  # daily D1 -> R2 backup (UNI-27)
    restore-d1.mjs                 # restore a D1 dump from R2 (UNI-27)
    provision-university.mjs       # spin up a new customer tenant end-to-end (UNI-28)
    decommission-university.mjs    # tear a customer tenant back down (UNI-28)
    audit-gate.mjs                 # npm audit CI gate (UNI-29)
    license-check.mjs              # license-allowlist CI gate (UNI-29)
    setup-git-hooks.mjs            # wires core.hooksPath to scripts/git-hooks (UNI-29)
    git-hooks/pre-commit           # secret-scan pre-commit hook (UNI-29)
  provisioning/                # generated per-tenant wrangler.toml files (gitignored)
  .dev.vars.example            # Worker local secrets template
  .env.example                 # Frontend (Vite) env template
  package.json                 # npm workspaces root + top-level scripts
```

## Local development

### Prerequisites

- Node.js >= 20
- npm >= 9
- `wrangler` CLI (installed automatically as a Worker workspace dev dep —
  invoke via `npm` scripts; no global install required)

### Install + first-run setup

```bash
git clone https://github.com/lastcow/university-hub-v2.git
cd university-hub-v2
npm install

cp .dev.vars.example apps/worker/.dev.vars
cp .env.example apps/web/.env
# (Mailgun vars in .dev.vars can stay as the placeholder sentinels — the
# email service short-circuits to a "not configured" failure on those.)

# `npm install` also wires this checkout's pre-commit hook (secret-scan
# gate; see docs/security-ci.md). If the postinstall is skipped for any
# reason, run `npm run setup:hooks`.

# Apply migrations + seed dev data into the local D1 sqlite store.
npm run db:migrate:local
```

### Run frontend + worker

```bash
npm run dev
```

Boots both processes via `concurrently`:

| Process | Port    | Notes                                                                   |
|---------|---------|-------------------------------------------------------------------------|
| Worker  | `:8787` | `wrangler dev --local`, sqlite-backed D1 under `apps/worker/.wrangler/` |
| Web     | `:5173` | Vite dev server. `/api/*` requests proxy to the Worker.                 |

Or start them individually:

```bash
npm run dev:worker
npm run dev:web
```

Smoke-test the Worker:

```bash
curl http://127.0.0.1:8787/api/health
# => {"ok":true,"data":{"ok":true,"service":"university-hub-worker","timestamp":"..."}}
```

### Typecheck

```bash
npm run typecheck   # tsc -b across all workspaces
```

### Tests

```bash
npm test            # vitest in apps/worker
```

158 tests across auth, mail, RBAC, and every route handler. The frontend has
no automated test suite yet — UI behavior is verified manually + via the §38
quality gate (see [docs/deployment.md](docs/deployment.md)).

### Database (D1)

D1 is SQLite under the hood. Schema lives in SQL migrations under
`migrations/` and is applied with `wrangler d1 migrations apply DB`.
`apps/worker/wrangler.toml` sets `migrations_dir = "../../migrations"` so
wrangler picks them up from the root.

| File                                 | What it does                                                                                |
|--------------------------------------|---------------------------------------------------------------------------------------------|
| `migrations/0001_initial_schema.sql` | All core tables + indexes (epic §18, §19).                                                   |
| `migrations/0002_email_logs.sql`     | `email_logs` table for Mailgun delivery tracking + indexes.                                  |
| `migrations/0003_seed_dev_data.sql`  | Demo university, super_admin, demo users for each role, demo departments and courses. **Dev only.** |

#### Apply migrations

```bash
# Local — uses a sqlite file under apps/worker/.wrangler/. No Cloudflare
# account or live D1 needed. This also seeds dev data via 0003_*.sql.
npm run db:migrate:local

# Production — applies against the real D1 database.
npm run db:migrate
```

> **Production seeding warning.** `0003_seed_dev_data.sql` ships demo users
> with a known dev password and is safe in dev only. For production, see the
> "First admin / bootstrap" section below — do **not** apply 0003 to a real
> D1 database.

#### Sanity-check the local DB

```bash
npm run db:exec:local -- --command "SELECT count(*) AS n FROM users"
npm run db:exec:local -- --command "SELECT email, role FROM users ORDER BY role"
```

#### Reset local DB

```bash
rm -rf apps/worker/.wrangler
npm run db:migrate:local
```

#### Dev super_admin login

The seed creates a super_admin and one demo user per role. They share the
same dev password.

| Field    | Value                  |
|----------|------------------------|
| Email    | `superadmin@dev.local` |
| Password | `DevSuperAdmin!2026`   |

Other dev users follow `<role>@dev.local` with the same password
(`uniadmin@dev.local`, `staff@dev.local`, `faculty@dev.local`,
`teacher@dev.local`, `ta@dev.local`, `student@dev.local`, `guest@dev.local`,
`viewer@dev.local`).

Full schema rationale (UUID-as-TEXT PKs, FK enforcement via `PRAGMA
foreign_keys`, password hash format) lives in [docs/database.md](docs/database.md).

## Cloudflare setup

The app ships as **two separate Cloudflare services**:

| Resource      | Default name              | Hostname (default)                                  |
|---------------|---------------------------|-----------------------------------------------------|
| D1 database   | `university-hub-v2`       | (binding only — no public URL)                      |
| Worker        | `university-hub-v2`       | `https://university-hub-v2.<account>.workers.dev/`  |
| Pages project | `university-hub-v2-web`   | `https://university-hub-v2-web.pages.dev/`          |

The Worker serves only `/api/*`. The Vite-built SPA lives on the Pages
project and reaches the Worker cross-origin via `fetch(...)`. Cross-origin
requests are gated by the `ALLOWED_WEB_ORIGINS` Worker var (defaults to the
Pages production URL; add custom domains and preview wildcards as needed —
see [docs/deployment.md](docs/deployment.md#cors-allowlist)). Custom
domains (`app.example.com` / `api.example.com` style) are documented in
the same file as a future step.

### Wrangler secret commands

Production secrets are set with:

```bash
wrangler secret put SESSION_SECRET
wrangler secret put MAILGUN_API_KEY
wrangler secret put MAILGUN_DOMAIN
wrangler secret put MAILGUN_FROM_EMAIL
wrangler secret put MAILGUN_FROM_NAME
wrangler secret put APP_BASE_URL
# optional
wrangler secret put MAILGUN_REGION
wrangler secret put SUPPORT_EMAIL

# one-shot, for first super_admin bootstrap (see below)
wrangler secret put BOOTSTRAP_SECRET
```

Local dev secrets go in `apps/worker/.dev.vars` (copy from `.dev.vars.example`).
Frontend build-time vars go in `apps/web/.env` (copy from `.env.example`).
Neither file is committed — see `.gitignore`.

## Mailgun

All transactional email goes through Mailgun. **Template HTML is canonical
in this repo** under `mailgun_templates/<name>/` (HTML body + plaintext +
metadata); the Mailgun account holds a downstream copy that's pushed by
`npm run sync:mailgun-templates`. The Worker only sends template names +
variables, never raw HTML. The Mailgun API key is **never** exposed to the
browser; the Mailgun status UI shows `Configured` / `Missing configuration`
only, never the secret value.

### Required template names (epic §13)

```
university_hub_invitation
university_hub_invitation_resend
university_hub_welcome
university_hub_password_reset
university_hub_contact_notification
university_hub_account_status_changed
```

### Required Worker env vars

| Var                  | Purpose                                            |
|----------------------|----------------------------------------------------|
| `MAILGUN_API_KEY`    | Mailgun private API key (secret).                  |
| `MAILGUN_DOMAIN`     | Verified Mailgun sending domain.                   |
| `MAILGUN_FROM_EMAIL` | `From:` address (must match the verified domain).  |
| `MAILGUN_FROM_NAME`  | Human-readable `From:` name.                       |
| `MAILGUN_REGION`     | Optional. `US` (default) or `EU`.                  |

When any of the four required vars is unset (or still set to a
`replace-with-...` placeholder sentinel), the email service short-circuits to
a `mailgun_not_configured` result — every `email_logs` row gets a structured
failure reason and no HTTP request to Mailgun is made. The Settings UI will
display **Missing configuration** until the secrets are provisioned.

### Templates

Canonical HTML + plaintext for every template lives under
[`mailgun_templates/`](mailgun_templates/). Push local edits to the Mailgun
account with:

```bash
MAILGUN_API_KEY=... MAILGUN_DOMAIN=... npm run sync:mailgun-templates
```

The script reads `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `MAILGUN_REGION`
from your environment (or `apps/worker/.dev.vars`), is idempotent, and
prints what it created / updated / left unchanged.

Full Mailgun setup walkthrough — account, verified domain, template
authoring, variable list — is in [docs/mailgun.md](docs/mailgun.md).

## Env vars (`.dev.vars.example`)

```
APP_ENV=development
APP_NAME=University Hub
APP_BASE_URL=http://localhost:5173

SESSION_COOKIE_NAME=university_hub_session
SESSION_SECRET=replace-with-local-secret

MAILGUN_API_KEY=replace-with-mailgun-api-key
MAILGUN_DOMAIN=replace-with-mailgun-domain
MAILGUN_FROM_EMAIL=no-reply@example.com
MAILGUN_FROM_NAME=University Hub
MAILGUN_REGION=US

SUPPORT_EMAIL=support@example.com

# BOOTSTRAP_SECRET=...   # set as a wrangler secret in production only
```

Frontend (`apps/web/.env.example`):

```
# VITE_API_BASE_URL=https://university-hub-v2.<your-account>.workers.dev
VITE_APP_NAME=University Hub
```

In dev, leave `VITE_API_BASE_URL` unset — the Vite dev server proxies
`/api/*` to the local Worker on `:8787` (see `apps/web/vite.config.ts`).
In production builds (e.g. on the Cloudflare Pages project), set it to
the deployed Worker origin so the SPA on `*.pages.dev` knows where the
API lives.

Only `VITE_*`-prefixed vars are exposed to the browser. Do not put secrets
in `.env`.

## Deployment

Detailed end-to-end Cloudflare deploy walkthrough — `wrangler login`,
provisioning D1, applying migrations, setting secrets, deploying Worker
*and* Pages, verifying CORS + cookies — lives in
[docs/deployment.md](docs/deployment.md). High level:

```bash
# 1. Authenticate
npx wrangler login

# 2. Provision D1 (one-time). Copy the returned database_id into wrangler.toml.
npx wrangler d1 create university-hub-v2

# 3. Apply migrations against the live DB.
npm run db:migrate                 # remote D1

# 4. Provision the Pages project (one-time).
cd apps/web && npx wrangler pages project create university-hub-v2-web \
  --production-branch=main && cd -

# 5. Set Worker secrets (see "Wrangler secret commands" above).

# 6. Build the SPA pointing at the deployed Worker, then deploy to Pages.
VITE_API_BASE_URL=https://university-hub-v2.<your-account>.workers.dev \
  npm run build
npx wrangler pages deploy apps/web/dist --project-name=university-hub-v2-web

# 7. Deploy the API-only Worker.
cd apps/worker && npx wrangler deploy
```

Open the Pages URL (`https://university-hub-v2-web.pages.dev/`) to use
the app. Custom domains for both services are an optional follow-up — see
[docs/deployment.md → Custom domains](docs/deployment.md#custom-domains-future-step).

### Per-customer provisioning

Single-tenant per university is the deployment model: each customer gets
its own Worker + D1 + Pages project. The 7-step walkthrough above
provisions the SaaS-level baseline; the per-customer flow runs on top of
it via:

```bash
npm run provision:university -- \
  --name="Acme University" --slug=acme \
  --admin-email=admin@acme.edu --admin-name="Site Admin" \
  [--custom-domain=hub.acme.edu]
```

The script creates the per-tenant D1 + Worker + Pages project, applies
non-seed migrations, sets every secret, and bootstraps the customer's
super_admin in a single run. Re-running with the same inputs is a no-op.
Tear-down via `npm run decommission:university -- --slug=<slug>
--confirm`. Full walkthrough in
[docs/per-customer-provisioning.md](docs/per-customer-provisioning.md).

## Auth flow

1. Visitor lands on `/` (public).
2. Visitor either follows an invitation link or clicks **Sign in**.
3. `/sign-in` POSTs `{ email, password }` to `/api/auth/sign-in`.
4. Worker looks up the user by lowercased email, verifies the password with
   constant-time PBKDF2, creates a session row (token hashed with SHA-256),
   sets an HttpOnly cookie, audit-logs `auth.sign_in`.
5. `/api/auth/me` returns the current `SessionUser` (no password hash, ever).
6. `/api/auth/sign-out` clears the session row and the cookie.

Session lifetime: 30 days. Wrong-email and wrong-password collapse to the
same `Invalid email or password.` 401 so existence is not leaked. Full
details in [docs/auth.md](docs/auth.md).

## Invitation flow

There is no public registration. New users join only via invitation:

1. An authorized admin (super_admin / university_admin) opens
   `/app/invitations` and creates an invitation `{ email, role,
   university_id?, expires_at? }`.
2. Worker generates a single-use random token, stores **only its SHA-256
   hash** in `invitations.token_hash`, and emails the **raw** token in the
   `invitation_url` template variable.
3. Invitee opens `/accept-invitation?token=<raw-token>`, which calls
   `GET /api/invitations/lookup` to validate the token (still pending, not
   expired, hash matches) and shows the account-setup form.
4. POST `/api/invitations/accept` exchanges the token for a new user account
   with the invited role + status `active`, marks the invitation `accepted`,
   sends the welcome email, and issues a session cookie.

Tokens are single-use; expired / accepted / revoked invitations always
reject. Raw tokens never touch the database. Full lifecycle (resend, revoke,
rate limit) in [docs/auth.md](docs/auth.md).

## RBAC overview

Roles (DB / API values, lowercase / snake_case):

```
super_admin, university_admin, staff, faculty, teacher,
teacher_assistant, student, guest, viewer
```

- The backend enforces every permission check; frontend role-based hiding is
  for convenience only.
- `super_admin` is unscoped. Every other admin role is scoped to their own
  `university_id`. Privilege escalation in invitations is blocked
  (`canInvite` + `rolesInvitableBy` in `packages/shared`).
- All sensitive actions emit an `audit_logs` row (`invitation.created`,
  `user.role_changed`, `course.deleted`, `auth.sign_in`, etc. — see epic §30
  for the full list).
- `403 Forbidden` is returned for unauthorized actions; never 404 (which
  would leak existence).

The full role-permission matrix is in [docs/auth.md](docs/auth.md).

## First admin / bootstrap

University Hub is invitation-only — there is no public sign-up. To create
the very first super_admin in a brand-new production environment, use one
of the two paths below.

### Path A — `npm run bootstrap:admin` (recommended)

The Worker exposes `POST /api/bootstrap/super-admin`, gated by the
`BOOTSTRAP_SECRET` env var. Until that secret is set, the endpoint returns
404 — it effectively does not exist. Once any `super_admin` row exists, the
endpoint returns `409 already_bootstrapped` regardless of the secret. So the
secret is genuinely one-shot.

```bash
# 1. Mint a long random secret and set it on the deployed Worker.
SECRET=$(openssl rand -hex 32)
echo "$SECRET" | npx wrangler secret put BOOTSTRAP_SECRET

# 2. Run the bootstrap script (prompts for the new admin password).
BOOTSTRAP_SECRET="$SECRET" npm run bootstrap:admin -- \
  --url=https://university-hub-v2.<your-account>.workers.dev \
  --email=admin@example.com \
  --name="Site Admin" \
  --university-name="Example University"

# 3. Close the door.
npx wrangler secret delete BOOTSTRAP_SECRET
```

For CI / unattended use, supply the password via env var instead of a TTY
prompt:

```bash
ADMIN_PASSWORD='S0meStr0ngPassword!' \
BOOTSTRAP_SECRET="$SECRET" \
  npm run bootstrap:admin -- \
    --url=https://... \
    --email=admin@example.com \
    --name="Site Admin" \
    --password-env=ADMIN_PASSWORD
```

### Path B — `wrangler d1 execute` (manual fallback)

If you would rather not expose a bootstrap endpoint at all, mint the user
locally and insert directly:

```bash
HASH=$(node scripts/hash-password.mjs 'S0meStr0ngPassword!')
UID=$(uuidgen | tr 'A-Z' 'a-z')   # or any UUID v4 generator

cd apps/worker && npx wrangler d1 execute DB --remote --command "
  INSERT INTO users (id, email, password_hash, name, role, status)
  VALUES ('$UID', 'admin@example.com', '$HASH', 'Site Admin', 'super_admin', 'active');
"
```

After either path, sign in at `https://<your-host>/sign-in`, head to
`/app/invitations`, and invite everyone else. There is no other path into
the system.

## Common troubleshooting

| Symptom                                                         | Likely cause / fix                                                                                                                                                 |
|-----------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `npm run dev:worker` fails with `D1_ERROR: no such table: users`| Migrations not applied to the local DB. Run `npm run db:migrate:local`.                                                                                            |
| Sign-in always returns `invalid_credentials`                    | Wrong password (default dev: `DevSuperAdmin!2026`), or the user's `status` is not `active`. Confirm with `db:exec:local` `SELECT email, status FROM users`.        |
| `/app/*` redirects back to `/sign-in` immediately               | Session cookie missing or expired. Sign in again; check that `SESSION_COOKIE_NAME` matches between Worker env and the cookie the browser sends.                    |
| `/api/auth/sign-in` succeeds but `/api/auth/me` returns 401     | Cross-site cookie not attached. Confirm the response from sign-in includes `Set-Cookie: ...; SameSite=None; Secure`, and that `APP_ENV=production` is set on the deployed Worker so the cookie helper picks the cross-site attributes. |
| Browser logs `CORS error` / `No 'Access-Control-Allow-Origin'`  | The Pages origin is not in `ALLOWED_WEB_ORIGINS`. Update via `npx wrangler secret put ALLOWED_WEB_ORIGINS` (comma-separated, supports `https://*.<project>.pages.dev` for previews). |
| Mailgun status reads **Missing configuration**                  | Expected before secrets are provisioned. Once you set `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `MAILGUN_FROM_EMAIL` / `MAILGUN_FROM_NAME` it will flip to **Configured**. |
| Invitation email shows `failed` in `/app/email-logs`            | The Worker stored the invitation but Mailgun rejected the send (often: domain not verified, template not authored, key revoked). Click **Resend** after fixing.    |
| Email accepted by Mailgun but never arrives in the inbox        | Likely "Template not found" — the Worker calls a template that's missing from the Mailgun domain. Run `npm run sync:mailgun-templates` and re-send.                |
| Invitation acceptance returns `invitation_invalid`              | Token consumed, expired, or revoked. Have an admin issue a fresh invitation.                                                                                       |
| `403 forbidden_role` when creating an invitation                | The actor's role is not allowed to invite the requested role. See `rolesInvitableBy` in `packages/shared` and [docs/auth.md](docs/auth.md).                        |
| `npm run bootstrap:admin` returns 404                           | `BOOTSTRAP_SECRET` is not set on the Worker. Run `npx wrangler secret put BOOTSTRAP_SECRET`.                                                                       |
| `npm run bootstrap:admin` returns `409 already_bootstrapped`    | A super_admin already exists. Sign in at `/sign-in`, or invite a new super_admin from `/app/invitations`.                                                          |
| Cloudflare deploy fails with `D1 database not found`            | The `database_id` in `apps/worker/wrangler.toml` does not exist in this account. Run `npx wrangler d1 list` to confirm or `wrangler d1 create` to provision.       |

For deploy specifics, see [docs/deployment.md](docs/deployment.md). For
Mailgun-side failures, see [docs/mailgun.md](docs/mailgun.md).
