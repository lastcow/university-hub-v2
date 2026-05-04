# Deployment

End-to-end walkthrough for shipping University Hub to Cloudflare. The repo
is designed so a single Worker can serve both the API (`/api/*`) and the
built SPA (everything else) via the `[assets]` binding in
`apps/worker/wrangler.toml`. You can also deploy the frontend separately to
Cloudflare Pages — both paths are documented below.

> **Audience:** the operator running the first production deploy. After
> that, this doc is a reference for re-deploys, rollback, and adding new
> environments.

## Prerequisites

- Cloudflare account with Workers + D1 access (the free plan is sufficient
  for small deployments).
- `npx wrangler` available (no global install required — invoke via
  `npx wrangler` inside `apps/worker/`).
- Node.js >= 20 and npm >= 9 locally.
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exported in your shell
  (or `npx wrangler login` for an interactive session).

## 1. Authenticate

```bash
npx wrangler login
# or, for CI / unattended:
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

Confirm with `npx wrangler whoami`.

## 2. Provision the D1 database (one-time)

```bash
npx wrangler d1 create university-hub-v2
```

The output includes a `database_id`. Open `apps/worker/wrangler.toml` and
update the `[[d1_databases]]` block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "university-hub-v2"
database_id = "<paste the new id>"
migrations_dir = "../../migrations"
```

Commit the `database_id` change — it is not a secret, just a Cloudflare
resource identifier.

If you are deploying into an existing account that already has a
`university-hub-v2` database (e.g. the one provisioned in `7f5080d`), skip
this step and confirm with `npx wrangler d1 list`.

## 3. Apply migrations against the live D1

From the repo root:

```bash
npm run db:migrate           # remote (--remote on apps/worker)
```

This applies `migrations/0001_initial_schema.sql` and
`migrations/0002_email_logs.sql`. Wrangler tracks applied migrations
server-side, so re-running is safe.

> **Do not apply `0003_seed_dev_data.sql` to production.** It seeds demo
> users with a known dev password. The migrations directory contains it
> for local dev only; if you are paranoid, temporarily move it out before
> running the remote apply, then put it back. (Or just trust wrangler's
> tracking — if this is a fresh DB, you'd be opting in by name with
> `wrangler d1 execute`.)

## 4. Set Worker secrets

Run all of these from inside `apps/worker/` so wrangler picks up the
binding config:

```bash
cd apps/worker

# Session signing
npx wrangler secret put SESSION_SECRET

# Public origin (used for invitation URLs in Mailgun templates)
npx wrangler secret put APP_BASE_URL
# e.g. https://university-hub-v2.<your-account>.workers.dev
# or your custom domain such as https://hub.example.com

# Mailgun (see docs/mailgun.md for what to set them to)
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_DOMAIN
npx wrangler secret put MAILGUN_FROM_EMAIL
npx wrangler secret put MAILGUN_FROM_NAME
# optional
npx wrangler secret put MAILGUN_REGION
npx wrangler secret put SUPPORT_EMAIL
```

> **Mailgun is not yet provisioned.** This is fine. If you skip the four
> Mailgun secrets entirely, the Settings page will show **Missing
> configuration**, the email service will short-circuit, and every send
> will land in `email_logs` with `mailgun_not_configured`. The rest of the
> app — sign-in, RBAC, pages, audit logs — will work correctly. Add real
> Mailgun secrets later via the same `wrangler secret put` flow; no
> redeploy needed.

`SESSION_SECRET` and `APP_BASE_URL` are required for the auth + invitation
flows to work end-to-end.

You can list configured secrets at any time with:

```bash
npx wrangler secret list
```

`wrangler secret list` only shows names, never values — Cloudflare itself
does not expose them after the initial `put`.

## 5. Build the frontend

From the repo root:

```bash
npm install
npm run build
```

Outputs to `apps/web/dist/`, which the Worker's `[assets]` binding serves.

## 6. Deploy

### Path A — single Worker serves API + SPA (recommended)

```bash
cd apps/worker
npx wrangler deploy
```

This uploads the Worker bundle and the static assets from
`apps/web/dist/`. The Worker URL (e.g.
`https://university-hub-v2.<your-account>.workers.dev`) now serves both
`/api/*` and the SPA fallback.

Update `APP_BASE_URL` to that origin if you didn't already, then redeploy
or re-set the secret — invitation URLs in Mailgun templates use it.

### Path B — Pages for the SPA, Worker for the API

If you'd rather have separate Pages + Worker projects:

1. **Worker** — the same `wrangler deploy` from `apps/worker/` ships only
   the API. Optional: drop the `[assets]` block from `wrangler.toml` so the
   Worker doesn't try to serve a non-existent SPA, and route `/api/*` to
   it via Cloudflare Routes or a custom domain.
2. **Pages** — connect the GitHub repo to Cloudflare Pages with:
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `apps/web/dist`
   - **Root directory:** *(leave blank — repo root)*
   - **Environment variables:** `VITE_API_BASE_URL=<your-worker-origin>`,
     `VITE_APP_NAME=University Hub`.
3. Verify both endpoints serve and the SPA can reach `/api/*` (CORS is not
   needed when the Worker is on the same origin via a route).

## 7. Bootstrap the first super_admin

There is no public registration. To get the first admin in:

```bash
# Mint a long random secret and wire it onto the Worker.
SECRET=$(openssl rand -hex 32)
echo "$SECRET" | npx wrangler secret put BOOTSTRAP_SECRET

# From the repo root.
BOOTSTRAP_SECRET="$SECRET" npm run bootstrap:admin -- \
  --url=https://university-hub-v2.<your-account>.workers.dev \
  --email=admin@example.com \
  --name="Site Admin" \
  --university-name="Example University"

# Close the door behind you.
npx wrangler secret delete BOOTSTRAP_SECRET
```

The endpoint is `POST /api/bootstrap/super-admin`. It 404s without
`BOOTSTRAP_SECRET`, 401s with the wrong secret, and 409s once any
super_admin exists. See [README → First admin / bootstrap](../README.md#first-admin--bootstrap)
and [docs/auth.md](auth.md#security-checklist-epic-23-38).

If you'd rather avoid the endpoint entirely, the manual `wrangler d1
execute` path is documented in the same README section.

## 8. Quality gate (epic §38)

Walk this end-to-end on the deployed environment before declaring the
release done. Run `curl` from any machine; click-throughs need a browser.

- [ ] **Build clean:** `npm run build` from the repo root finishes with no
      errors. (Already validated by CI / locally before deploy.)
- [ ] **TypeScript clean:** `npm run typecheck` passes.
- [ ] **Tests:** `npm test` passes (158+ vitest cases including bootstrap).
- [ ] **Migrations valid:** `npm run db:migrate` reports no pending
      migrations after a re-run.
- [ ] **Public pages render:** visit `/`, `/features`, `/about`,
      `/contact`, `/sign-in`, `/accept-invitation?token=does-not-exist`.
      Each renders the public layout with consistent Tailwind / shadcn
      styling.
- [ ] **Protected pages auth-gated:** hit any `/app/...` URL while signed
      out — the SPA redirects to `/sign-in`. Hit any `/api/...` protected
      route directly with `curl` while logged out — get a `401`.
- [ ] **Invitation-only onboarding works:** sign in as the bootstrapped
      super_admin → `/app/invitations` → create an invitation → confirm
      it appears in `/app/email-logs` with the right status. If Mailgun is
      configured, open the invitation link in a private window and accept
      it; you should land signed in on `/app`.
- [ ] **Mailgun routes through templates:** the email body matches the
      Mailgun template you authored, with all `{{ variable }}`
      placeholders filled in. Confirm via the Mailgun dashboard's
      "Sending → Logs" view as well.
- [ ] **Email failures handled safely:** with `MAILGUN_API_KEY` unset (or
      placeholder), invitation creation still succeeds — the
      `/app/email-logs` row reads `failed: mailgun_not_configured`, and
      the API response surfaces `email_status: "failed"`. No raw Mailgun
      error or API key is exposed to the frontend.
- [ ] **RBAC enforced server-side:** sign in as a non-admin (e.g. the
      `student` dev user, or any user invited as `student`). Try
      `curl -b cookies.txt -X POST .../api/invitations -H 'content-type:
      application/json' -d '{...}'` — the Worker returns `403 forbidden`,
      not the SPA-level "not allowed" page.
- [ ] **Audit + email logs written:** sign in, create an invitation,
      revoke it. `/app/audit-logs` shows `auth.sign_in`,
      `invitation.created`, `invitation.revoked`. `/app/email-logs`
      shows the matching email row.
- [ ] **Consistent Tailwind/shadcn styling:** spot-check public + protected
      pages in light theme; layout, typography, card / table styles match.
- [ ] **No secrets reach the frontend:** open the browser devtools
      Network tab during a sign-in + `/api/settings/mailgun-status` call.
      Confirm no Mailgun API key, session secret, password hash, or raw
      invitation token appears in any response body.
- [ ] **No raw invitation tokens or plaintext passwords stored:**
      `npm run db:exec -- --command "SELECT token_hash FROM invitations
      LIMIT 1"` returns hex hashes; `SELECT password_hash FROM users
      LIMIT 1` returns `pbkdf2-sha256$...` strings. Neither table contains
      a column for raw tokens / plaintext passwords by schema.
- [ ] **Bootstrap endpoint closed:** `BOOTSTRAP_SECRET` removed
      (`npx wrangler secret list` no longer lists it). `curl -X POST
      .../api/bootstrap/super-admin` returns `404`.

If any item fails, open a follow-up issue (or send the Developer back to
fix it before redeploying).

## Re-deploys

For subsequent ships:

```bash
git pull
npm install
npm run build
cd apps/worker && npx wrangler deploy
# new migrations only
npm run db:migrate
```

Wrangler tracks applied migrations server-side, so re-running
`db:migrate` after every deploy is safe.

## Rollback

Cloudflare Workers retains versioned deploys. To roll back:

```bash
cd apps/worker
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

D1 migrations are forward-only by design (this repo does not ship `down`
migrations). If a migration corrupts data, restore from a Cloudflare D1
backup or write a compensating migration.

## Custom domain

Cloudflare Workers and Pages both accept custom hostnames via the
dashboard. After binding `hub.example.com` to the Worker:

1. Re-set `APP_BASE_URL` to the new origin so invitation URLs use it:
   ```bash
   echo "https://hub.example.com" | npx wrangler secret put APP_BASE_URL
   ```
2. If using Path B (Pages), re-set the Pages project's
   `VITE_API_BASE_URL` env var and redeploy.

## Deletion / decommissioning

```bash
cd apps/worker
npx wrangler delete
npx wrangler d1 delete university-hub-v2
```

This is destructive — D1 deletion drops all data. There is no undo from the
CLI; restore from a backup if you need to recover.
