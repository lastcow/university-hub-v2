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

For local dev, `wrangler dev --local` uses a sqlite file under `.wrangler/`
(gitignored) — no Cloudflare account or live D1 needed. The `DB` binding is
declared in `apps/worker/wrangler.toml`. Real migrations and seed land in a
later issue under `migrations/` and are applied with
`wrangler d1 migrations apply DB`.

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
