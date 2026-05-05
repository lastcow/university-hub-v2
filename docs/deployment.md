# Deployment

End-to-end walkthrough for shipping University Hub to Cloudflare. The app
ships as **two separate Cloudflare services**:

- **Cloudflare Pages** — `university-hub-v2-web` — serves the Vite-built SPA
  from `apps/web/dist/` at `https://university-hub-v2-web.pages.dev/`.
- **Cloudflare Worker** — `university-hub-v2` — serves only `/api/*` at
  `https://university-hub-v2.<your-account>.workers.dev/`. The browser
  reaches it cross-origin from the Pages SPA.

The SPA does cross-site `fetch(...)` calls to the Worker with credentials,
which means CORS and cross-site cookies have to be configured correctly —
this doc covers both.

> **Audience:** the operator running the first production deploy. After
> that, this doc is a reference for re-deploys, rollback, and adding new
> environments.

## Prerequisites

- Cloudflare account with Workers + Pages + D1 access (the free plan is
  sufficient for small deployments).
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

## 4. Provision the Cloudflare Pages project (one-time)

The Pages project name doubles as the default `*.pages.dev` hostname.
`university-hub-v2-web` is the recommended name (it can't collide with the
Worker, which is also `university-hub-v2`):

```bash
cd apps/web
npx wrangler pages project create university-hub-v2-web \
  --production-branch=main
```

If you'd rather use the dashboard, the equivalent is **Workers & Pages →
Create → Pages → Direct Upload → Project name: `university-hub-v2-web`**.

If `wrangler pages project list` shows the project already exists (e.g.
QA created it on a previous attempt), skip this step.

> **GitHub-integrated builds are nice-to-have, not required.** The
> walkthrough below uses the manual `wrangler pages deploy` command so
> the Developer's branch can be rolled out without wiring up the Pages
> GitHub app first. Once you're happy, hook the project to the GitHub
> repo via **Pages → Settings → Builds & deployments** for auto-deploy.

## 5. Set Worker secrets and vars

Run all secret commands from inside `apps/worker/` so wrangler picks up
the binding config:

```bash
cd apps/worker

# Session signing
npx wrangler secret put SESSION_SECRET

# Public web URL — used inside Mailgun email templates (invitation /
# welcome / password-reset URLs). Point it at the Pages origin, NOT the
# Worker origin: links in emails open the SPA, which then calls the API.
npx wrangler secret put APP_BASE_URL
# e.g. https://university-hub-v2-web.pages.dev
# or your custom Pages domain (e.g. https://app.example.com)

# Mailgun (see docs/mailgun.md for what to set them to)
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_DOMAIN
npx wrangler secret put MAILGUN_FROM_EMAIL
npx wrangler secret put MAILGUN_FROM_NAME
# optional
npx wrangler secret put MAILGUN_REGION
npx wrangler secret put SUPPORT_EMAIL
```

The `[vars]` block in `wrangler.toml` declares two non-secret values that
ship with every Worker deploy:

| Var                   | Default                                          | Purpose                                                                         |
|-----------------------|--------------------------------------------------|---------------------------------------------------------------------------------|
| `APP_ENV`             | `production`                                     | Flips cookie defaults to `SameSite=None; Secure` (see "Cookies" below).         |
| `ALLOWED_WEB_ORIGINS` | `https://university-hub-v2-web.pages.dev`        | Comma-separated CORS allowlist. Add preview hosts here (see "CORS" below).      |

To change either without redeploying the code, override per environment:

```bash
cd apps/worker
# Add a custom-domain origin alongside the default Pages URL.
echo "https://university-hub-v2-web.pages.dev,https://app.example.com" \
  | npx wrangler secret put ALLOWED_WEB_ORIGINS
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

### CORS allowlist

The Worker accepts cross-origin API calls only from origins listed in
`ALLOWED_WEB_ORIGINS`. The format is comma-separated; entries can be:

| Entry                                          | Matches                                          |
|------------------------------------------------|--------------------------------------------------|
| `https://university-hub-v2-web.pages.dev`      | the production Pages URL exactly                 |
| `https://*.university-hub-v2-web.pages.dev`    | every Pages preview deploy (`<sha>.<project>.pages.dev`) |
| `https://app.example.com`                      | a custom-domain Pages alias                      |

`http://localhost:5173` is always allowed in dev (`APP_ENV=development`,
default during `wrangler dev`). It is **not** allowed in production unless
you list it explicitly.

Disallowed origins still receive a `204` for an `OPTIONS` preflight and a
plain JSON response for other methods — but with no `Access-Control-Allow-*`
headers, so the browser blocks the response. The Worker never returns `*`
in `Access-Control-Allow-Origin`; it always echoes a single matched origin
because the SPA uses `credentials: 'include'`.

### Cookies (cross-site)

Because the SPA on `*.pages.dev` and the Worker on `*.workers.dev` are
different sites, the session cookie has to be `SameSite=None; Secure`.
Otherwise the browser refuses to attach it on `fetch(...)`. The cookie
helper in `apps/worker/src/utils/cookies.ts` does this automatically:

| `APP_ENV`         | Cookie attributes                              |
|-------------------|------------------------------------------------|
| `production`      | `HttpOnly; Secure; SameSite=None`              |
| `development`     | `HttpOnly; SameSite=Lax` (no `Secure`, so http://localhost works) |

A `Domain=` attribute is intentionally **not set** — the cookie is host-only
on the Worker host, which is exactly what we want when only the SPA uses
it. If you later move the Worker behind a custom domain (e.g. `api.example.com`)
and want to share the cookie with sibling subdomains, that's the moment to
add `Domain=example.com`; today it would be a footgun.

## 6. Build and deploy the SPA to Pages

From the repo root:

```bash
# Build the SPA. The default-tenant Worker origin is committed to
# apps/web/.env.production so a fresh checkout `npm run build` "just
# works"; per-tenant deploys override by exporting the var explicitly:
#
#   VITE_API_BASE_URL=https://university-hub-v2.<your-account>.workers.dev \
#     npm run build
#
# `vite.config.ts` hard-fails the production build if the resolved
# value is empty (UNI-46), and the postbuild gate
# `scripts/check-web-bundle.mjs` re-asserts that the resolved URL was
# actually baked into the JS chunk.
npm run build

# Deploy the built SPA to Cloudflare Pages.
npx wrangler pages deploy apps/web/dist --project-name=university-hub-v2-web

# Smoke-check the deploy. Asserts the bundle on Pages contains the
# Worker host, that the Worker preflight allows the Pages origin, and
# that POST /api/* still returns 405 from Pages (i.e. the SPA must call
# the Worker directly). Pass --pages-url for previews.
npm run smoke:pages
# or, against a preview URL:
# npm run smoke:pages -- --pages-url=https://<sha>.university-hub-v2-web.pages.dev
```

Wrangler prints the deploy URL on success — both the unique preview
(`https://<sha>.university-hub-v2-web.pages.dev`) and the production alias
(`https://university-hub-v2-web.pages.dev`).

> **Why the build-time guard?** A production deploy without
> `VITE_API_BASE_URL` ships a SPA that calls relative `/api/...` paths.
> Pages serves the SPA HTML fallback for GETs (200 text/html) and
> rejects POSTs with 405 — sign-in is broken. UNI-43 + UNI-46 were the
> resulting incidents; the env var is now codified in the repo and the
> build refuses to start without it.

### Setting `VITE_API_BASE_URL` permanently on Pages

If you wire the Pages project to GitHub for auto-deploys, set the env var
in the dashboard so you don't have to pass it on every `npm run build`:

**Pages → Settings → Environment variables → Production**:

| Name                | Value                                                       |
|---------------------|-------------------------------------------------------------|
| `VITE_API_BASE_URL` | `https://university-hub-v2.<your-account>.workers.dev`      |
| `VITE_APP_NAME`     | `University Hub` (optional)                                 |

Build settings:

- **Framework preset:** None (Vite)
- **Build command:** `npm install && npm run build`
- **Build output directory:** `apps/web/dist`
- **Root directory:** *(leave blank — repo root)*

Pages serves a single-page-application fallback by default for unknown
routes — no extra `_redirects` or `_routes.json` is needed for `/sign-in`,
`/app/dashboard`, etc. to resolve to `index.html`.

## 7. Deploy the Worker

```bash
cd apps/worker
npx wrangler deploy
```

This uploads the Worker bundle. The Worker URL (e.g.
`https://university-hub-v2.<your-account>.workers.dev`) now serves only
`/api/*`. The root URL returns a small JSON 404 — that's expected; the SPA
lives on the Pages project.

If you change the Pages project name or add a custom domain, re-set
`ALLOWED_WEB_ORIGINS` and `APP_BASE_URL` (no Worker redeploy needed for
either — `wrangler secret put` and `[vars]` updates take effect on the
next request).

## 8. Bootstrap the first super_admin

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

## 9. Quality gate (epic §38)

Walk this end-to-end on the deployed pair before declaring the release
done. Run `curl` from any machine; click-throughs need a browser.

- [ ] **Build clean:** `npm run build` from the repo root finishes with no
      errors. (Already validated by CI / locally before deploy.)
- [ ] **TypeScript clean:** `npm run typecheck` passes.
- [ ] **Tests:** `npm test` passes (180+ vitest cases including bootstrap,
      CORS, and cookie helpers).
- [ ] **Migrations valid:** `npm run db:migrate` reports no pending
      migrations after a re-run.
- [ ] **Worker is API-only:** `curl -i https://<worker-host>/` returns a
      `404 not_found` JSON — NOT SPA HTML. Same for
      `https://<worker-host>/sign-in`. Anything outside `/api/*` is a 404.
- [ ] **Pages serves the SPA:** visit `https://<pages-host>/`, `/features`,
      `/about`, `/contact`, `/sign-in`,
      `/accept-invitation?token=does-not-exist`, `/app/dashboard`. Each
      renders the SPA HTML (Pages auto-fallback for unknown routes is what
      makes nested routes work).
- [ ] **CORS preflight from the Pages origin succeeds:**
      ```bash
      curl -i -X OPTIONS https://<worker-host>/api/auth/sign-in \
        -H "Origin: https://<pages-host>" \
        -H "Access-Control-Request-Method: POST"
      ```
      Returns 204 with `Access-Control-Allow-Origin: https://<pages-host>`,
      `Access-Control-Allow-Credentials: true`,
      `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`.
- [ ] **CORS preflight from a foreign origin is blocked:**
      ```bash
      curl -i -X OPTIONS https://<worker-host>/api/auth/sign-in \
        -H "Origin: https://evil.example.com" \
        -H "Access-Control-Request-Method: POST"
      ```
      Returns 204 with **no** `Access-Control-Allow-Origin` header.
- [ ] **Sign-in works end-to-end:** open `https://<pages-host>/sign-in`,
      submit credentials, land on `/app/dashboard`. In devtools,
      `POST /api/auth/sign-in` returns a `Set-Cookie:
      university_hub_session=...; HttpOnly; Secure; SameSite=None`. The
      next `GET /api/auth/me` includes the cookie and returns the
      SessionUser.
- [ ] **Protected pages auth-gated:** hit any `/app/...` URL on Pages
      while signed out — the SPA redirects to `/sign-in`. Hit any
      `/api/...` protected route directly with `curl` while logged out —
      get a `401`.
- [ ] **Invitation-only onboarding works:** sign in as the bootstrapped
      super_admin → `/app/invitations` → create an invitation → confirm
      it appears in `/app/email-logs` with the right status. If Mailgun is
      configured, open the invitation link in a private window and accept
      it; you should land signed in on `/app`. (The link in the email
      uses `APP_BASE_URL`, which should point at the Pages origin.)
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

# Web — set VITE_API_BASE_URL once via the Pages dashboard, or pass it on
# every build below.
VITE_API_BASE_URL=https://university-hub-v2.<your-account>.workers.dev \
  npm run build
npx wrangler pages deploy apps/web/dist --project-name=university-hub-v2-web

# Worker
cd apps/worker && npx wrangler deploy && cd -

# new migrations only
npm run db:migrate
```

Wrangler tracks applied migrations server-side, so re-running
`db:migrate` after every deploy is safe.

## Rollback

Cloudflare Workers retains versioned deploys:

```bash
cd apps/worker
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

Cloudflare Pages retains every deploy as well, accessible via the
dashboard (**Pages → Deployments → ⋯ → Rollback to this deployment**) or
via the API. Pages and Worker rollbacks are independent — you can roll
back one without the other if a regression is isolated.

D1 migrations are forward-only by design (this repo does not ship `down`
migrations). If a migration corrupts data, restore from a Cloudflare D1
backup or write a compensating migration. The full restore procedure
lives in [docs/disaster-recovery.md](disaster-recovery.md).

## D1 backups (UNI-27)

Daily D1 backups are written to a Cloudflare R2 bucket
(`university-hub-backups` by default). Two independent schedulers run
the backup at 02:00 UTC daily so a failure in one doesn't silently leave
you without a backup:

- **GitHub Actions** (primary) — `.github/workflows/d1-backup.yml`,
  invokes `scripts/backup-d1.mjs` from a hosted runner.
- **Workers Cron Trigger** (defense-in-depth) — declared in
  `apps/worker/wrangler.toml`; the Worker's `scheduled(...)` handler
  calls `D1.dump()` and uploads the SQLite binary to R2.

Retention: 30 dailies, 12 weeklies, 6 monthlies. Restoration is run
through `scripts/restore-d1.mjs` against a scratch D1, never directly
into production.

Full setup (R2 bucket creation, repo-secret wiring for GitHub Actions,
the in-Worker binding, lifecycle rules), the restore procedure, and the
"production data was lost" runbook all live in
[docs/disaster-recovery.md](disaster-recovery.md). Provision the bucket
during first deploy so the cron has somewhere to write on day one.

## Per-customer provisioning

The walkthrough above is the *first* deploy onto a new Cloudflare account
— the SaaS-level baseline. After that, every customer university is its
own Worker + D1 + Pages project. The per-customer provisioning flow is
automated in `scripts/provision-university.mjs` and documented in
[docs/per-customer-provisioning.md](per-customer-provisioning.md).

Quick sketch (full inputs + idempotency rules in that doc):

```bash
npm run provision:university -- \
  --name="Acme University" --slug=acme \
  --admin-email=admin@acme.edu --admin-name="Site Admin" \
  [--custom-domain=hub.acme.edu] \
  [--mailgun-api-key=... --mailgun-domain=... \
   --mailgun-from-email=... --mailgun-from-name=...]
```

Tear-down with `npm run decommission:university -- --slug=<slug> --confirm`.

## Custom domains (future step)

This deploy uses default `*.pages.dev` and `*.workers.dev` hostnames so
the first ship is unblocked. To upgrade to vanity hostnames (e.g.
`app.retrocow.io` for the SPA, `api.retrocow.io` for the Worker):

1. **Pages custom domain.** **Pages → Custom domains → Set up a custom
   domain → `app.retrocow.io`**. Cloudflare provisions the cert; once
   verified, requests to `app.retrocow.io` route to the Pages project.
2. **Worker custom domain.** **Workers → `university-hub-v2` → Triggers
   → Custom Domains → Add Custom Domain → `api.retrocow.io`**. Cloudflare
   provisions the cert and binds the hostname to the Worker.
3. Re-set `APP_BASE_URL` to the SPA's new origin so invitation URLs use
   it:
   ```bash
   echo "https://app.retrocow.io" \
     | npx wrangler secret put APP_BASE_URL
   ```
4. Re-set `ALLOWED_WEB_ORIGINS` so the Worker accepts the new SPA origin
   (and any preview deploys you still want):
   ```bash
   echo "https://app.retrocow.io,https://*.university-hub-v2-web.pages.dev" \
     | npx wrangler secret put ALLOWED_WEB_ORIGINS
   ```
5. Update `VITE_API_BASE_URL` on the Pages project to
   `https://api.retrocow.io` and trigger a fresh Pages deploy so the SPA
   bundles the new API URL.
6. *(Optional — only if you want sibling-subdomain cookie sharing.)*
   Update the cookie helper in `apps/worker/src/utils/cookies.ts` to set
   `Domain=retrocow.io`. Without this the cookie stays host-only on
   `api.retrocow.io`, which is fine for the Pages SPA but means tools
   like Cypress / Playwright pointing at the apex domain won't see it.

## Recommended add-on: Cloudflare-edge rate-limit rules (UNI-25)

The Worker enforces application-aware rate limits (per-email sign-in
caps, per-session MFA caps, generic per-IP limits — see
`apps/worker/src/middleware/rate-limit.ts`). For network-layer abuse —
sustained scrapers, dumb DDoS, single IPs hammering a path before the
Worker even reads the body — layer Cloudflare's edge **Rate Limiting
Rules** in front. They run before the Worker billing meter, so they're
free protection against bulk-volume attacks the Worker would otherwise
spend CPU on.

Suggested starter rules (configure under **Security → WAF → Rate
limiting rules** in the Cloudflare dashboard, OR check them into
`wrangler.toml` once Cloudflare exposes them in TOML — today the
dashboard is the only path):

| Rule                                            | Match                                                      | Threshold              | Action      |
|-------------------------------------------------|------------------------------------------------------------|------------------------|-------------|
| Block runaway scrapers                          | `(http.request.uri.path matches "^/api/")`                 | 600 req / IP / minute  | Block 10 min|
| Cap raw sign-in volume                          | `(http.request.uri.path eq "/api/auth/sign-in")`           | 60 req / IP / minute   | Challenge   |
| Cap raw password-reset volume                   | `(http.request.uri.path eq "/api/auth/password-reset/request")` | 30 req / IP / minute | Challenge   |

These thresholds are deliberately looser than the Worker's per-email
limits — the edge layer is for crude volume protection; the Worker is
where per-email / per-session intelligence lives. The two layers
compose: edge stops obvious floods, Worker stops targeted credential
stuffing.

Field-level DDoS (network layer 3/4) is already handled by Cloudflare's
free tier on every domain; nothing to configure.

## Deletion / decommissioning

```bash
cd apps/worker
npx wrangler delete
npx wrangler d1 delete university-hub-v2
```

Then the Pages project:

```bash
cd apps/web
npx wrangler pages project delete university-hub-v2-web
```

This is destructive — D1 deletion drops all data. There is no undo from
the CLI; restore from a backup if you need to recover.
