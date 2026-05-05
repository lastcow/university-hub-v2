# Canvas LMS integration

This document covers the Canvas-side setup needed to develop and test
the LMS sync feature against a Canvas sandbox. It complements the
runtime substrate documented in `docs/encryption.md` (per-tenant token
encryption) and the architectural decisions in epic UNI-50.

The Canvas adapter lives at `apps/worker/src/lms/canvas/` (sub-issue
UNI-52). It implements the `LmsProvider` interface defined by sub-issue
UNI-51 and is registered on the process-wide registry as a side-effect
of importing `apps/worker/src/lms/canvas/index.js` from the Worker
entry-point.

## Audience

Engineers and operators preparing a Canvas sandbox for end-to-end QA
verification of UNI-50 (Phase 1 — Canvas MVP). Not a customer-facing
guide; the customer-admin OAuth setup flow is documented separately as
part of UNI-53 (Settings → Integrations admin tab).

## 1 — Get a Canvas instructor sandbox

Instructure runs a free sandbox at <https://canvas.instructure.com>:

1. Visit <https://canvas.instructure.com/register> and pick **I'm a
   Teacher**. The free instructor account is fully featured for our
   purposes — it gives you one root account, the ability to create
   courses, and admin access on those courses.
2. Verify your email (Instructure sends a confirmation link).
3. Create one or two **courses** under your sandbox so the sync flow
   has data to pull. Add a couple of student users (you can use
   throwaway emails) and enroll them in the course. The sync test
   requires at least one course with at least one student enrollment.
4. Note your sandbox's **base URL** — for instructure.com sandboxes,
   it is `https://canvas.instructure.com`. For institution-run
   instances, it will look like `https://canvas.<your-institution>.edu`.
   This is the value an admin enters in University Hub's
   Settings → Integrations form (UNI-53).

## 2 — Register an OAuth developer key

Canvas authenticates third-party integrations with OAuth 2.0 developer
keys. The free instructor account does NOT grant developer-key
permissions on the root account — for testing the OAuth dance you need
an admin to issue a key.

For QA against a production-style instance, follow these steps as a
Canvas root-account admin:

1. Sign in to Canvas as a root-account admin (not the free instructor
   account; an institution-run instance, or instructure.com's
   "Free for Teachers" version, will not have this option).
2. Go to **Admin → Site Admin → Developer Keys** (or **Admin →
   Developer Keys** on a non-Site Admin instance).
3. Click **+ Developer Key → + API Key**.
4. Fill in:
   - **Key Name**: e.g. `University Hub (dev)`
   - **Owner Email**: your dev contact
   - **Redirect URIs**: comma-separated list of every redirect URI you
     plan to use for this key. For local development:
     `http://localhost:8787/api/lms/canvas/callback` (the Worker dev
     port). For deployed environments, the production callback URL
     served by the Worker, e.g.
     `https://<your-worker>.workers.dev/api/lms/canvas/callback`.
   - **Icon URL**, **Vendor Code**, **Notes**: optional.
   - **Scopes**: leave **Enforce Scopes** OFF for sandbox testing
     (Canvas grants the developer-key default), or turn it ON and
     select the explicit scopes listed in §3.
5. Save. Canvas reveals the **Client ID** and **Client Secret** once.
   Copy both immediately — the secret is not retrievable later.
6. Set the developer key's **State** toggle to **ON** (Canvas creates
   keys in the OFF state by default; OAuth requests against an OFF
   key fail).

If you don't have admin access to a Canvas instance, the simplest path
for sandbox QA is to run Canvas locally via the
[Instructure docker-compose stack](https://github.com/instructure/canvas-lms/blob/master/doc/docker/quick_start.md)
and provision a developer key there. This is overkill for unit tests
(which mock fetch) but essential for end-to-end OAuth verification.

## 3 — Required scopes

When **Enforce Scopes** is ON, Canvas only honors the OAuth scopes you
explicitly grant. The Phase 1 Canvas adapter needs:

- `url:GET|/api/v1/accounts/:account_id/terms`
- `url:GET|/api/v1/courses` (with `enrollment_state=active`,
  `enrollment_role[]=TeacherEnrollment`, `enrollment_role[]=TaEnrollment`,
  `include[]=term`)
- `url:GET|/api/v1/courses/:id/enrollments` (with `type[]=StudentEnrollment`,
  `type[]=TeacherEnrollment`, `type[]=TaEnrollment`, `include[]=user`,
  `include[]=email`)

Pick the matching boxes in the developer-key UI under **Scopes**. If
you skip Enforce Scopes, Canvas grants the developer-key default
(read-only access to most user-scoped endpoints) which already covers
all three.

## 4 — Account scoping for `listTerms`

Canvas's `/api/v1/accounts/{account_id}/terms` endpoint requires the
caller to have admin permissions on that account. Regular instructors
typically do NOT have those permissions, so the adapter requests
`/api/v1/accounts/self/terms` and falls back to deriving the term list
from the user's courses (with `include[]=term`) when Canvas responds
with 401 or 403.

The fallback covers the common case (an instructor connecting their
sandbox account); admins who want the full term list — including terms
the user has no courses in — should grant the OAuth app account-level
scope. The fallback path lives in
`apps/worker/src/lms/canvas/api.ts:deriveTermsFromCourses` and is
covered by `test/lms/canvas/provider.test.ts` ("falls back to
course-derived terms on 401").

## 5 — Run the full flow against the sandbox

This walks through verifying the integration end-to-end against a real
Canvas sandbox. Pre-reqs: a Canvas sandbox with a developer key (§2),
the dev Worker running, and a Hub user with `university_admin` role.

1. **Configure the OAuth client in Hub.** Sign in as a `university_admin`
   and visit **Settings → Integrations → Canvas** (UNI-53). Enter the
   Canvas **base URL**, **client id**, and **client secret**. The
   client secret is field-encrypted via `apps/worker/src/crypto/
   field-encryption.ts` before it lands in `lms_provider_configs`.
2. **Connect the user account.** Sign in as a `faculty` /
   `teacher` / `teacher_assistant` user and visit
   `/app/integrations` (UNI-54). Click **Connect Canvas**. The browser
   is redirected to Canvas's authorize page, where the user approves
   the scopes and is redirected back to `/api/lms/canvas/callback` with
   a `code` and `state` param.
3. **Verify the connection row.** The Worker's callback handler
   exchanges the `code` for tokens via
   `apps/worker/src/lms/canvas/oauth.ts:exchangeCodeForTokens`,
   field-encrypts the access + refresh tokens, and writes a row to
   `lms_connections` with `status='active'` and a populated
   `token_expires_at`. Inspect via:
   ```sh
   cd apps/worker && npx wrangler d1 execute DB --local --command \
     "SELECT id, user_id, provider_id, status, token_expires_at FROM lms_connections;"
   ```
4. **Run a sync.** Visit `/app/integrations`, pick a term, preview the
   course + student counts, and execute (UNI-55). The reconciliation
   engine (UNI-56) writes to `terms`, `courses`, `students`,
   `course_assignments`, plus `lms_sync_runs` for status tracking and
   `disclosure_log` / `audit_logs` for FERPA tracing.
5. **Inspect the run.** Both `summary_json` and `error_log_json` on the
   `lms_sync_runs` row carry the per-row counters for the UI poll path.

## 6 — Local dev callback URL

For local development, register the redirect URI exactly as the Worker
serves it. Wrangler's `wrangler dev --local --port 8787` puts the
Worker at `http://localhost:8787`, so the callback is:

```
http://localhost:8787/api/lms/canvas/callback
```

Canvas allows multiple redirect URIs per developer key, so register
each environment's URL up-front to avoid round-tripping through the key
UI when switching between local and deployed Workers.

## 7 — Personal Access Token (PAT) setup

PAT auth was pulled into Phase 1 (originally Phase 2) when the first
customer's Canvas test target turned out to expose only a PAT — see
`migrations/0016_lms_auth_method.sql` for the schema change that backs
this. PAT users skip the entire OAuth dance: they paste a long-lived
token from the Canvas UI, Hub stores it field-encrypted, and there is
no refresh path (when the PAT expires, the user re-pastes a fresh one).

### Mint a PAT in Canvas

1. Sign in to Canvas as the instructor whose courses you want to sync.
2. Open **Account → Settings**. Scroll to the **Approved Integrations**
   section.
3. Click **+ New Access Token**.
4. Fill in:
   - **Purpose**: e.g. `University Hub sync`. The free-text label is
     surfaced in Canvas's Approved Integrations list so the user can
     revoke the token later.
   - **Expires**: leave blank for a non-expiring PAT, or set a date.
     Canvas does not warn on or near expiry — set a date only if your
     security policy mandates rotation, and remember to re-paste a
     fresh PAT in Hub before then.
5. Click **Generate Token**. Canvas reveals the PAT exactly once.

### Connect via PAT in Hub

1. Sign in as a `faculty` / `teacher` / `teacher_assistant` user and
   visit `/app/integrations` (UNI-54).
2. Choose **Connect with Personal Access Token** instead of the OAuth
   button. Paste the PAT into the form and submit.
3. The Worker's connect handler calls
   `CanvasProvider.authenticate({ personal_access_token: <pat> }, ...)`,
   which short-circuits the OAuth dance and returns an `LmsConnection`
   with:
   - `auth_method: 'pat'`
   - `access_token: <pat>` (field-encrypted at storage time)
   - `refresh_token: null`
   - `token_expires_at: null`
   - `scope: null`
4. Verify via D1:
   ```sh
   cd apps/worker && npx wrangler d1 execute DB --local --command \
     "SELECT id, user_id, auth_method, status FROM lms_connections;"
   ```
   The new row should show `auth_method = 'pat'`.

### When a PAT stops working

The reconciliation engine treats a 401 from Canvas the same way for
both auth methods — it marks the connection `status = 'expired'` and
surfaces a "reconnect" prompt in the UI. For an OAuth row the
"reconnect" path attempts a refresh first; for a PAT row it
unconditionally requires the user to paste a fresh token. The
provider enforces this contract: `CanvasProvider.refreshToken` throws
on a `auth_method = 'pat'` connection rather than silently no-op'ing,
so callers cannot accidentally treat the absence of a refresh token
as "all good".

## 8 — Out of scope (Phase 2 sub-issues)

The Phase 1 Canvas adapter intentionally omits:

- **Token-refresh edge cases.** The adapter handles the happy-path
  refresh exchange (`refreshAccessToken`); error-recovery paths
  (revoked tokens, refresh-token expiry, partial response) get
  hardened in Phase 2. PAT happy-path is in Phase 1 (§7); PAT
  expiry-detection improvements are Phase 2.
- **Rate-limit retries.** A 429 response surfaces as a sync error;
  exponential backoff + queued retry is Phase 2.
- **Background scheduled sync.** Today's flow is on-demand only. A
  cron-driven background sync is Phase 2.

## 9 — Token storage and rotation

Tokens never sit in plaintext in D1. `lms_provider_configs.client_secret_encrypted`,
`lms_connections.access_token_encrypted`, and
`lms_connections.refresh_token_encrypted` are all wrapped via the
per-tenant AES-GCM helper in `apps/worker/src/crypto/field-encryption.ts`.
Master-key rotation procedure: see `docs/encryption.md`.

## 10 — Test fixtures

The Canvas adapter is unit-tested with `fetch` mocked. Sample Canvas
JSON responses live at `apps/worker/test/lms/canvas/fixtures/`:

- `terms.json` — `/api/v1/accounts/:id/terms` happy-path response.
- `courses-page1.json` / `courses-page2.json` — paginated `/api/v1/courses`
  with the Link-header `rel="next"` chain.
- `enrollments.json` — `/api/v1/courses/:id/enrollments` with
  student / teacher / TA / observer mix (observer is dropped by the
  mapper).
- `token-exchange.json` — `/login/oauth2/token` response for the
  authorization-code grant.

To add a new fixture, check the actual response shape from your sandbox
via `curl` (with a developer-key access token), redact any secrets,
drop it under `fixtures/`, and reference it from a vitest case via
`loadFixture("name.json")` (see `helpers.ts`).
