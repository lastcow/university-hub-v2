# Mailgun

University Hub uses **Mailgun** for every transactional email — invitation,
welcome, password reset, contact-form notification, account-status change. No
other email provider is supported (epic UNI-1 §3) and no email is ever sent
directly from the frontend (epic §13).

> **HTML lives in Mailgun, not in this repo.** The Worker only ships the
> template **name** + a flat dictionary of variables. Mailgun's template
> engine (Handlebars) renders the body. To change the look of an email, edit
> the template in the Mailgun dashboard — no redeploy needed.

## Setup checklist

1. **Create or use a Mailgun account.** Either region works (US is the
   default; set `MAILGUN_REGION=EU` if you provisioned in the EU region).
2. **Add and verify a sending domain.** Mailgun → Sending → Domains → Add
   New Domain. Follow the SPF / DKIM DNS instructions. Wait for verification
   to complete before sending real mail.
3. **Generate a private API key.** Mailgun → Account Settings → API Keys →
   *Private API key*. Treat this as a secret; never commit it.
4. **Author the six templates** (see "Templates" below). Make sure each one
   exists with **exactly** the names listed — the Worker calls them by name.
5. **Provision the Worker secrets** with `wrangler secret put` (see
   "Worker env vars" below).
6. **Smoke-test.** Sign in to the deployed app as a super_admin, create a
   test invitation, and confirm:
   - Invitation arrives in the recipient's inbox using the right template.
   - `/app/email-logs` shows a row with `status = sent` and a populated
     `mailgun_message_id`.

## Worker env vars

Set every required var as a **wrangler secret** in production. Never commit
real values to `.dev.vars`; the example file ships with `replace-with-...`
sentinels which are detected and treated as **Missing configuration** by
the Worker (see "Status semantics" below).

| Var                  | Required | Type         | Notes                                                                 |
|----------------------|----------|--------------|-----------------------------------------------------------------------|
| `MAILGUN_API_KEY`    | Yes      | secret       | Private API key from the Mailgun dashboard.                           |
| `MAILGUN_DOMAIN`     | Yes      | secret       | Verified Mailgun sending domain (e.g. `mg.example.com`).              |
| `MAILGUN_FROM_EMAIL` | Yes      | secret       | `From:` address. Must be on the verified `MAILGUN_DOMAIN`.            |
| `MAILGUN_FROM_NAME`  | Yes      | secret       | Human-readable `From:` name (e.g. `University Hub`).                  |
| `MAILGUN_REGION`     | No       | secret / var | `US` (default, used when unset) or `EU`. Selects the API base host.   |
| `APP_BASE_URL`       | Yes      | secret / var | The public origin used to build invitation / reset links.             |
| `APP_NAME`           | No       | var          | Used in the `app_name` template variable. Defaults to `University Hub`.|
| `SUPPORT_EMAIL`      | No       | secret / var | Used as `support_email` and as the contact-notification recipient.    |

Set them with:

```bash
wrangler secret put MAILGUN_API_KEY
wrangler secret put MAILGUN_DOMAIN
wrangler secret put MAILGUN_FROM_EMAIL
wrangler secret put MAILGUN_FROM_NAME
wrangler secret put APP_BASE_URL
# optional
wrangler secret put MAILGUN_REGION
wrangler secret put SUPPORT_EMAIL
```

Run from inside `apps/worker/` so wrangler picks up `wrangler.toml`.

### Status semantics

`GET /api/settings/mailgun-status` returns one of `Configured` /
`Missing configuration` per variable, plus the (non-secret) `MAILGUN_REGION`
value when set. **Secret values are never returned** (epic §29). The
"missing" rule is:

- The var is unset, **or**
- The var is empty / whitespace, **or**
- The var still starts with `replace-with-` (the placeholder sentinel from
  `.dev.vars.example`).

Any of those conditions causes the email service to short-circuit to a
`mailgun_not_configured` failure result — no HTTP request to Mailgun is made,
but the attempt is still recorded in `email_logs` with that reason.

## Required templates (epic §13)

Authored in the Mailgun dashboard under **Sending → Templates**. The names
must match exactly — the Worker references them by name from
`packages/shared/src/constants/mailgun.ts`.

| Template name                          | Sent when                                                                 |
|----------------------------------------|---------------------------------------------------------------------------|
| `university_hub_invitation`            | An admin creates an invitation.                                           |
| `university_hub_invitation_resend`     | An admin resends an existing pending invitation.                          |
| `university_hub_welcome`               | A user accepts an invitation and a session is issued.                     |
| `university_hub_password_reset`        | A password reset is requested. (Reset flow is reserved for a later issue.)|
| `university_hub_contact_notification`  | A visitor submits the public `/contact` form.                             |
| `university_hub_account_status_changed`| An admin activates / deactivates / suspends an account.                   |

For each template, set both the HTML and plain-text bodies (Mailgun renders
both). Subject lines live in Mailgun and can reference the same variables.

## Template variables

Every send call merges three sources, with later sources winning:

1. **Defaults** (always present): `app_name`, `app_base_url`, `support_email`.
2. **Recipient defaults**: `recipient_email`.
3. **Per-call variables** supplied by the route that triggered the send.

Below is the variable contract per template. Treat the *guaranteed* set as
a hard contract — those variables will be present on every send. *Optional*
variables are populated when the originating record carries them.

### `university_hub_invitation` and `university_hub_invitation_resend`

Fired from `apps/worker/src/routes/invitations.ts` (`handleCreateInvitation`,
`handleResendInvitation`).

| Variable                | Guaranteed | Source                                                  |
|-------------------------|------------|---------------------------------------------------------|
| `app_name`              | yes        | `APP_NAME`                                              |
| `app_base_url`          | yes        | `APP_BASE_URL`                                          |
| `support_email`         | yes        | `SUPPORT_EMAIL`                                         |
| `recipient_email`       | yes        | invitation `email`                                       |
| `recipient_name`        | yes        | falls back to `recipient_email` until the user accepts  |
| `invited_by_name`       | yes        | inviting admin's `name`                                 |
| `university_name`       | yes        | invitation's `university` (empty string for super_admin invitations) |
| `invitation_url`        | yes        | `${APP_BASE_URL}/accept-invitation?token=<raw-token>`   |
| `invitation_expires_at` | yes        | ISO-8601 string                                         |
| `role`                  | yes        | UI label (`Super Admin`, `Teacher Assistant`, …)        |

### `university_hub_welcome`

Fired from `handleAcceptInvitation` immediately after the user account is
created.

| Variable          | Guaranteed | Source                |
|-------------------|------------|-----------------------|
| `app_name`        | yes        | `APP_NAME`            |
| `app_base_url`    | yes        | `APP_BASE_URL`        |
| `support_email`   | yes        | `SUPPORT_EMAIL`       |
| `recipient_email` | yes        | new user's email      |
| `recipient_name`  | yes        | new user's `name`     |
| `university_name` | optional   | when scoped to a uni  |
| `role`            | yes        | UI label              |

### `university_hub_password_reset`

Reserved for a future password-reset flow. The contract is:

| Variable             | Guaranteed | Notes                                                        |
|----------------------|------------|--------------------------------------------------------------|
| `app_name`           | yes        |                                                              |
| `app_base_url`       | yes        |                                                              |
| `support_email`      | yes        |                                                              |
| `recipient_email`    | yes        |                                                              |
| `recipient_name`     | yes        |                                                              |
| `reset_password_url` | yes        | full URL with single-use token, expires in minutes           |

### `university_hub_contact_notification`

Fired from `apps/worker/src/routes/contact.ts` after a visitor submits the
public contact form. Recipient is `SUPPORT_EMAIL` (falls back to
`MAILGUN_FROM_EMAIL`).

| Variable          | Guaranteed | Source                          |
|-------------------|------------|---------------------------------|
| `app_name`        | yes        |                                 |
| `app_base_url`    | yes        |                                 |
| `support_email`   | yes        |                                 |
| `recipient_email` | yes        | `SUPPORT_EMAIL` (the recipient) |
| `contact_name`    | yes        | submitted form `name`           |
| `contact_email`   | yes        | submitted form `email`          |
| `contact_message` | yes        | submitted form `message`        |

### `university_hub_account_status_changed`

Fired from `apps/worker/src/routes/users.ts` (`handleUpdateUserStatus`).

| Variable          | Guaranteed | Source                                       |
|-------------------|------------|----------------------------------------------|
| `app_name`        | yes        |                                              |
| `app_base_url`    | yes        |                                              |
| `support_email`   | yes        |                                              |
| `recipient_email` | yes        | target user's email                          |
| `recipient_name`  | yes        | target user's `name`                         |
| `account_status`  | yes        | UI label (`Active`, `Inactive`, `Suspended`) |

## Email failure handling

Every email attempt — successful or not — writes one row to `email_logs`:

| Column                | Notes                                                                            |
|-----------------------|----------------------------------------------------------------------------------|
| `type`                | `invitation`, `invitation_resend`, `welcome`, `password_reset`, `contact_notification`, `account_status_changed` |
| `recipient`           | Lowercased email                                                                  |
| `template_name`       | Mailgun template name (`university_hub_*`)                                       |
| `status`              | `sent`, `failed`, or `pending`                                                   |
| `mailgun_message_id`  | Populated on success                                                             |
| `error`               | Stable failure code, optionally followed by a sanitized detail. See below.       |
| `related_entity_type` | `invitation` / `user` / `contact_message` when applicable                        |
| `related_entity_id`   | UUID of that entity                                                              |
| `university_id`       | When the action is scoped to a university                                        |

The error column always starts with one of the codes below. The Mailgun API
key is **never** written to `email_logs.error`, even when Mailgun returns it
in an error message — the Worker sanitizes the detail string in
`apps/worker/src/mail/mailgun.ts` before persisting.

| Code                       | Meaning                                                              |
|----------------------------|----------------------------------------------------------------------|
| `mailgun_not_configured`   | One or more required env vars missing / placeholder.                 |
| `mailgun_http_error`       | Mailgun returned a non-2xx response. Detail includes status code.    |
| `mailgun_network_error`    | `fetch` itself threw (DNS, TLS, timeout).                            |
| `mailgun_unexpected_error` | Anything else thrown inside the send path.                           |

Operational consequences:

- **Invitation creation, email fails:** the invitation row is created
  anyway. The API response surfaces `email_status: "failed"` so the admin
  sees the warning in the UI; the invitation can be **resent** from
  `/app/invitations` once the underlying issue is fixed.
- **Invitation resend, email fails:** invitation status is **not** changed.
  The `email_logs` row is written; `audit_logs` records `invitation.email_failed`.
- **All other sends (welcome, account status, contact):** logged and
  surfaced to admins via `/app/email-logs`. The originating user-facing
  action does not block on email delivery.

## Local development

`.dev.vars.example` ships with `replace-with-mailgun-api-key` and friends.
Leaving these as the placeholder sentinels is the recommended local default
— the Worker treats them as **Missing configuration** and never makes a
real Mailgun API call. Invitations created locally will land in the DB and
in `email_logs` with `mailgun_not_configured`, which is what you want for
day-to-day development.

To exercise a real send locally (sandbox domain or a personal domain),
populate `apps/worker/.dev.vars` with real values and restart `npm run
dev:worker`.

## Operational tips

- **Sandbox domains** are fine for first-deploy smoke tests but only deliver
  to addresses you've added to the sandbox's authorized recipient list. Use
  a verified domain for invitation flows.
- **Region matters.** EU-region keys do not work against the US API base and
  vice versa. Set `MAILGUN_REGION=EU` if your account lives in the EU.
- **Rotating the API key** = `wrangler secret put MAILGUN_API_KEY` with the
  new value. No redeploy needed; Worker reads the secret at request time.
- **Seeing `mailgun_http_error` with status 401:** the API key is wrong or
  was revoked. Mint a new one in Mailgun and re-`put` the secret.
- **Seeing `mailgun_http_error` with status 404 + "domain not found":**
  the `MAILGUN_DOMAIN` does not exist in the region you're calling. Check
  the dashboard region selector or set `MAILGUN_REGION=EU`.
