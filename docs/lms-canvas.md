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

UNI-63 collapsed the Canvas integration onto Personal Access Token
(PAT) auth. Admins configure only the institution's Canvas base URL per
university; users generate their own PAT in Canvas's Approved
Integrations page and paste it into Settings → Integrations. The OAuth
2.0 Authorization Code flow has been removed entirely — there is no
developer-key registration, no callback URL, no refresh exchange.

## Audience

Engineers and operators preparing a Canvas sandbox for end-to-end QA
verification of UNI-50 (Phase 1 — Canvas MVP).

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

## 2 — Required Canvas API surface

The Phase 1 Canvas adapter only reads. It calls:

- `GET /api/v1/users/self` — used to validate a PAT at connect-time
  (cheapest authenticated endpoint).
- `GET /api/v1/accounts/:account_id/terms` — admin-scoped term list,
  with a `/courses?include[]=term` fallback for non-admin users.
- `GET /api/v1/courses` — issued **twice**, once with
  `enrollment_type=teacher` and once with `enrollment_type=ta`, both
  with `enrollment_state=active`, `per_page=100`, and `include[]=term`.
  Canvas's user-scoped courses endpoint accepts only the **scalar**
  `enrollment_type` parameter; the array form (`enrollment_type[]` or
  `enrollment_role[]`) is silently ignored and Canvas returns `[]` —
  the symptom that produced UNI-67's 0/0 preview against the FSU
  operator's PAT. The two scalar calls run in parallel and the adapter
  dedupes by external course id.
- `GET /api/v1/courses/:id/enrollments` (with `type[]=StudentEnrollment`,
  `type[]=TeacherEnrollment`, `type[]=TaEnrollment`, `include[]=user`,
  `include[]=email`)

Every Canvas request carries `Authorization: Bearer <pat>`,
`User-Agent: UniversityHub/1.0`, and `Accept: application/json`. PATs
generated from the Canvas UI grant whatever scopes the user themself
holds — Canvas does not let a user mint a token with broader
permissions than they have, so no scope wrangling is required.

## 3 — Account scoping for `listTerms`

Canvas's `/api/v1/accounts/{account_id}/terms` endpoint requires the
caller to have admin permissions on that account. Regular instructors
typically do NOT have those permissions, so the adapter requests
`/api/v1/accounts/self/terms` and falls back to deriving the term list
from the user's courses (with `include[]=term`) when Canvas responds
with 401 or 403.

The fallback covers the common case (an instructor connecting their
sandbox account); admins who want the full term list — including terms
the user has no courses in — should ask the user to use an account-
admin Canvas login. The fallback path lives in
`apps/worker/src/lms/canvas/api.ts:deriveTermsFromCourses` and is
covered by `test/lms/canvas/provider.test.ts` ("falls back to
course-derived terms on 401").

## 4 — End-to-end PAT flow

This walks through verifying the integration end-to-end against a real
Canvas sandbox. Pre-reqs: a Canvas sandbox (§1), the dev Worker running,
and a Hub user with `university_admin` role.

### 4.1 — Configure the institution's Canvas tenant URL (admin)

Sign in as a `university_admin` and visit **Settings → Integrations →
Canvas** (UNI-53). Enter the Canvas **base URL** — the institution's
Canvas root, e.g. `https://canvas.instructure.com` or
`https://frostburg.instructure.com`. The form rejects non-`https://`
URLs and any URL with a path/query.

Optionally paste an admin-issued Canvas PAT into the **Test connection**
field. The Worker probes `<base_url>/api/v1/users/self` with the PAT;
on a 200 the row is saved, on a 401 the form surfaces "invalid token".
The probe PAT is never persisted — it lives only for the duration of
the save call.

### 4.2 — Mint a PAT in Canvas (per user)

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

### 4.3 — Connect via PAT in Hub (per user)

1. Sign in as a `faculty` / `teacher` / `teacher_assistant` user and
   visit `/app/integrations` (UNI-54).
2. Click **Connect Canvas**. The dialog presents the FERPA disclosure
   alongside a single password-masked input.
3. Paste the PAT, check the consent box, and click **Save and connect**.
4. The Worker's connect handler calls
   `validatePersonalAccessToken(<base_url>, <pat>)` against
   `/api/v1/users/self`. On a 200 the PAT is field-encrypted via
   `apps/worker/src/crypto/field-encryption.ts` and persisted to
   `lms_connections.access_token_encrypted`. On a 401 the response is
   `{ error: { code: "invalid_token" } }` and nothing is written.
5. Verify via D1:
   ```sh
   cd apps/worker && npx wrangler d1 execute DB --local --command \
     "SELECT id, user_id, base_url, status, last_synced_at FROM lms_connections;"
   ```
   `access_token_encrypted` is intentionally omitted from the SELECT —
   the column carries ciphertext only and never appears in any API
   response.

### 4.4 — Run a sync

Visit `/app/integrations`, pick a term, preview the course + student
counts, and execute (UNI-55). The reconciliation engine (UNI-56) writes
to `terms`, `courses`, `students`, `course_assignments`, plus
`lms_sync_runs` for status tracking and `disclosure_log` / `audit_logs`
for FERPA tracing.

## 5 — When a PAT stops working

If the user revokes the token in Canvas's Approved Integrations page,
or rotates it, the next sync hits a 401. The Worker:

1. Marks the `lms_connections` row `status = 'expired'`.
2. Returns an `lms_token_expired` error code to the SPA, which renders
   the standing "Re-paste a new token" copy in `/app/integrations`.
3. Does NOT delete the row — the user re-pastes a fresh PAT and the
   row's `last_synced_at` history is preserved.

The handlers driving this are `markConnectionExpired` and
`isCanvasUnauthorized` in `apps/worker/src/routes/lms-sync-runs.ts`.

## 6 — Disconnect

The user clicks **Disconnect** on `/app/integrations`. The Worker
deletes the `lms_connections` row outright (no `revoked` placeholder
state) and writes a `lms.disconnected` audit row. To re-connect, the
user mints a fresh PAT and goes back through §4.3.

## 7 — Token storage and rotation

The PAT never sits in plaintext in D1.
`lms_connections.access_token_encrypted` is wrapped via the per-tenant
AES-GCM helper in `apps/worker/src/crypto/field-encryption.ts`. The
plaintext PAT lives only:

- in the request body of `POST /api/lms/connections/canvas` (TLS-bound,
  not logged),
- in the `Authorization: Bearer <pat>` header on outbound Canvas REST
  calls (decrypted just-in-time inside the Worker, never written
  back),
- in the route handler's local closure for the duration of the call.

It is never returned in any API response, never echoed in audit
metadata, and never written to logs. Master-key rotation procedure: see
`docs/encryption.md`.

## 8 — Out of scope (Phase 2 sub-issues)

The Phase 1 Canvas adapter intentionally omits:

- **Rate-limit retries.** A 429 response surfaces as a sync error;
  exponential backoff + queued retry is Phase 2.
- **Background scheduled sync.** Today's flow is on-demand only. A
  cron-driven background sync is Phase 2.
- **PAT-rotation reminders.** Canvas does not surface PAT expiry to
  third-party callers; we do not poll for it. A "your token will
  expire in N days" UI hook would require the user to record the
  expiry at connect time.

## 9 — Test fixtures

The Canvas adapter is unit-tested with `fetch` mocked. Sample Canvas
JSON responses live at `apps/worker/test/lms/canvas/fixtures/`:

- `terms.json` — `/api/v1/accounts/:id/terms` happy-path response.
- `courses-page1.json` / `courses-page2.json` — paginated `/api/v1/courses`
  with the Link-header `rel="next"` chain.
- `enrollments.json` — `/api/v1/courses/:id/enrollments` with
  student / teacher / TA / observer mix (observer is dropped by the
  mapper).

To add a new fixture, check the actual response shape from your sandbox
via `curl` (with a PAT in the `Authorization` header), redact any
secrets, drop it under `fixtures/`, and reference it from a vitest case
via `loadFixture("name.json")` (see `helpers.ts`).
