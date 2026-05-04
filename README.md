# University Hub v2

A SaaS-style university management platform built on Cloudflare infrastructure.

> This README is a scaffold. Sections marked _TBD_ will be filled in by later
> issues as the corresponding subsystems land.

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind + shadcn/ui (Cloudflare Pages)
- **Backend:** Cloudflare Workers + TypeScript
- **Database:** Cloudflare D1 (SQL migrations under `migrations/`)
- **Email:** Mailgun (transactional only, templates managed in Mailgun)
- **Package manager:** **npm** (npm workspaces)
- **Node:** >= 20

## Repository layout

```
university-hub-v2/
  apps/
    web/              # React + Vite frontend (Cloudflare Pages)
    worker/           # Cloudflare Worker backend
  packages/
    shared/           # Types, schemas, constants shared by web + worker
  migrations/         # D1 SQL migrations
  docs/               # Operational docs (mailgun, deployment, database, auth)
  .dev.vars.example   # Worker dev secrets template
  .env.example        # Frontend (Vite) env template
  package.json        # npm workspaces root
  tsconfig.json       # TS project references root
```

The full structure is described in epic UNI-1, section 5.

## Local development

### Prerequisites

- Node.js >= 20
- npm >= 9
- (later issues) `wrangler` CLI for Cloudflare Workers / D1

### Install

```bash
npm install
```

This resolves the workspace graph and links `apps/*` and `packages/*`.

### Typecheck

The repo uses TypeScript project references. From the repo root:

```bash
npm run typecheck
```

This runs `tsc -b` across all workspaces. With the current scaffold (no source
files yet) it should complete with no errors.

### Run frontend + worker locally

```bash
npm run dev
```

Boots both processes via `concurrently`:

- **Worker** (`apps/worker`) on `http://127.0.0.1:8787` via `wrangler dev --local`.
  Uses a local sqlite-backed D1 under `.wrangler/` — no Cloudflare resources
  are touched (production D1 is provisioned by QA on deploy, see UNI-16).
- **Web** (`apps/web`) on `http://127.0.0.1:5173` via Vite. `/api/*` requests
  are proxied to the Worker.

To run them individually:

```bash
npm run dev:worker     # wrangler dev --local on :8787
npm run dev:web        # vite on :5173
```

Smoke-test the Worker:

```bash
curl http://127.0.0.1:8787/api/health
# => {"ok":true}
```

### Database (D1)

D1 is SQLite under the hood. Schema lives in SQL migrations under
`migrations/` at the repo root and is applied with `wrangler d1 migrations
apply DB`. `apps/worker/wrangler.toml` sets `migrations_dir = "../../migrations"`
so wrangler picks them up from there.

Migration files (in order):

| File                              | What it does                                                       |
|-----------------------------------|--------------------------------------------------------------------|
| `migrations/0001_initial_schema.sql` | All core tables + indexes (epic UNI-1 §18, §19).                |
| `migrations/0002_email_logs.sql`     | `email_logs` table for Mailgun delivery tracking + indexes.     |
| `migrations/0003_seed_dev_data.sql`  | Demo university, super_admin, demo users for each role, demo departments and courses. **Dev only.** |

Type conventions:
- UUIDs are `TEXT` (generated in the Worker via `crypto.randomUUID()`).
- Timestamps are ISO-8601 `TEXT` in UTC.
- Status enums are `TEXT` with `CHECK` constraints.

See [`docs/database.md`](docs/database.md) for the full rationale (UUID-as-TEXT
choice, FK enforcement via `PRAGMA foreign_keys`, password hashing format).

#### Apply migrations

From the repo root:

```bash
# Local — uses a sqlite file under apps/worker/.wrangler/. No Cloudflare
# account or live D1 needed. This also seeds dev data via 0003_*.sql.
npm run db:migrate:local

# Production — applies against the real D1 database. Skips 0003 only if you
# remove it from the migrations dir before deploy; the seed migration is
# safe to ship in dev environments but should NOT be applied in production.
npm run db:migrate
```

#### Sanity check

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

The seed creates a super_admin and one demo user per role (all share the same
dev password). These creds are dev-only.

| Field    | Value                  |
|----------|------------------------|
| Email    | `superadmin@dev.local` |
| Password | `DevSuperAdmin!2026`   |

Other dev users follow `<role>@dev.local` with the same password
(`uniadmin@dev.local`, `staff@dev.local`, `faculty@dev.local`,
`teacher@dev.local`, `ta@dev.local`, `student@dev.local`, `guest@dev.local`,
`viewer@dev.local`).

#### Hashing a new password (bootstrap / production super_admin)

Real auth lands in UNI-6, but the PBKDF2-SHA256 path is already in place.
Generate a hash compatible with the Worker auth module:

```bash
node scripts/hash-password.mjs '<password>'
```

## Cloudflare setup

Default resource names:

- D1 database: `university-hub-v2`
- Worker: `university-hub-v2`
- Pages project: `university-hub-v2`

_Full setup steps TBD — see `docs/deployment.md` once it lands._

## Mailgun

All transactional email goes through Mailgun. HTML lives in Mailgun-hosted
templates; the Worker only sends template names + variables. See `docs/mailgun.md`
(TBD) for the template list and required variables.

The Mailgun API key is **never** exposed to the browser. The Mailgun status UI
will show `Configured` / `Missing configuration` only — never the secret value.

## Wrangler secret commands

Once the Worker is wired up (UNI-3+), production secrets are set with:

```bash
wrangler secret put SESSION_SECRET
wrangler secret put MAILGUN_API_KEY
wrangler secret put MAILGUN_DOMAIN
wrangler secret put MAILGUN_FROM_EMAIL
wrangler secret put MAILGUN_FROM_NAME
wrangler secret put APP_BASE_URL
# optional
wrangler secret put MAILGUN_REGION
```

Local dev secrets go in `.dev.vars` (copy from `.dev.vars.example`). Frontend
build-time vars go in `.env` (copy from `.env.example`). Neither file is
committed — see `.gitignore`.

## Auth & invitation flow

Invitation-only onboarding. No public self-registration. Full flow documented
in `docs/auth.md` (TBD); the canonical spec is epic UNI-1 sections 12–14.

## RBAC

Backend enforces role permissions on every protected endpoint. Frontend role
checks are convenience only. Role list and scope are in epic UNI-1 sections
10–11.

## Bootstrap

- **Dev:** seed migration creates a demo university and a `super_admin` user.
- **Production:** one-time secure command creates the first `super_admin` or
  first invitation; everything after that is invitation-only.
