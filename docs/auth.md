# Authentication & RBAC

This document covers the auth flow, password handling, session lifecycle,
invitation lifecycle, and the role-permission matrix. The canonical product
spec is the [UNI-1 epic](../README.md), sections 10–16, 20–23, 30.

The cardinal rule across all of this:

> **Backend authoritative, frontend convenience-only.** Every protected
> endpoint re-checks auth, role, and university scope. Hiding a button in
> the UI is never the security control.

## Auth flow

### Sign-in

```
POST /api/auth/sign-in
body: { email, password }
```

1. Body parsed via the `signInInputSchema` zod schema (`packages/shared`).
2. Email lowercased + trimmed; password length-checked (≥ 8) before any
   DB lookup.
3. `users` table looked up by email.
4. Password verified with constant-time PBKDF2-SHA256 (see
   [docs/database.md](database.md#password-hashing)).
5. **Wrong email and wrong password collapse to the same `401
   invalid_credentials` response** with body `Invalid email or password.`
   so existence is not leaked.
6. `users.status` must be `active`. `pending` / `inactive` / `suspended` →
   `403 account_not_active`.
7. A session row is created (`sessions` table) with a fresh random token.
   The cookie carries the **raw** token; the DB stores only its SHA-256
   hash (`sessions.token_hash`).
8. `users.last_sign_in_at` is updated.
9. `audit_logs` row written: `action = auth.sign_in`,
   `actor_user_id = users.id`.
10. Response: `200 { ok: true, data: SessionUser }` + `Set-Cookie:
    university_hub_session=<raw-token>; HttpOnly; SameSite=Lax;
    [Secure when APP_ENV != development]`.

`SessionUser` deliberately excludes `password_hash` and any other secret —
the shape is enforced by `toSessionUser()` in `apps/worker/src/auth/session.ts`.

### Me

```
GET /api/auth/me
```

- 401 if no valid session cookie.
- Otherwise returns the same `SessionUser` shape.

### Sign-out

```
POST /api/auth/sign-out
```

- Idempotent. Deletes the matching `sessions` row by token hash.
- Audit: `auth.sign_out` (only when an authenticated session was present).
- Response sets a `Max-Age=0` clear-cookie.

## Password handling

- **Algorithm:** PBKDF2-SHA256, 100,000 iterations, 16-byte salt, 32-byte
  derived key. Implemented in `apps/worker/src/auth/password.ts` using the
  Web Crypto API (works in both Workers and Node 20+). The same algorithm
  is also used by `scripts/hash-password.mjs` and the seed migration.
- **Encoded format:** single string, four `$`-separated parts —
  `pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>`.
- **Comparison is constant-time** (per-byte XOR-OR over the full derived
  key length).
- **Plaintext passwords are never logged**, never returned in any API
  response, and never written outside `verifyPassword()` / `hashPassword()`.
- **Minimum length:** 8 characters. Enforced server-side at sign-in,
  invitation acceptance, password change, and bootstrap. The UI surfaces
  this in the invitation acceptance form, but the backend re-checks.

To mint a hash offline (used for the dev seed and as a fallback in the
manual bootstrap path):

```bash
node scripts/hash-password.mjs '<password>'
```

## Session lifecycle

| Property                 | Value                                                  |
|--------------------------|--------------------------------------------------------|
| Token entropy            | 32 random bytes from `crypto.getRandomValues`          |
| Token encoding (cookie)  | base64url, no padding                                  |
| Token storage (DB)       | SHA-256 hex of the raw token (no plaintext)            |
| Cookie name              | `SESSION_COOKIE_NAME` env (default `university_hub_session`) |
| Cookie attributes        | `HttpOnly; SameSite=Lax; Path=/; Secure` (prod)        |
| Lifetime                 | 30 days from creation                                  |
| Renewal                  | None — sign-in mints a fresh row each time             |
| Expiry handling          | Middleware deletes the row lazily on lookup miss        |

`sessions` columns also include `ip_address` and `user_agent` as recorded
at sign-in time, for audit triage. The Worker never trusts the cookie for
identity — every protected request re-reads the row + the linked `users`
row, so a deactivated user is locked out on their next request.

## Invitation flow

University Hub is invitation-only (epic §12). There is no public
`/sign-up` route, and the bootstrap endpoint is disabled by default in
production (see [README → First admin / bootstrap](../README.md#first-admin--bootstrap)).

### Creating an invitation

```
POST /api/invitations
body: { email, role, university_id?, expires_at? }
```

1. Actor must satisfy `canInvite(actor.role)` — only `super_admin` and
   `university_admin` (epic §11). Otherwise `403 forbidden`.
2. Target university is resolved:
   - `super_admin` may target any university (or `null` for global roles).
   - `university_admin` is forced to their own `university_id`. Trying to
     target another university yields `403 forbidden`.
3. Requested role must be in `rolesInvitableBy(actor.role)`. This blocks
   privilege escalation (a `university_admin` cannot invite `super_admin`,
   for example). Otherwise `403 forbidden_role`.
4. Reject if a `users` row already exists for that email
   (`409 user_exists`).
5. Reject if a non-expired `pending` invitation already exists for that
   email (`409 invitation_pending`) — admin should resend instead.
6. A random 32-byte token is generated. Only its SHA-256 hash is stored in
   `invitations.token_hash`. The raw token only ever appears in the
   `invitation_url` template variable on the outgoing Mailgun template.
7. Invitation row inserted with `status = 'pending'`, `expires_at = now() +
   7 days` (default — overridable via `expires_at` in the request).
8. Audit: `invitation.created`.
9. Mailgun send via the `university_hub_invitation` template (see
   [docs/mailgun.md](mailgun.md#university_hub_invitation-and-university_hub_invitation_resend)).
10. `email_logs` row written. If Mailgun failed, the invitation **stays
    valid** — admins see a `failed` email status in `/app/invitations` and
    can click **Resend**.

### Accepting an invitation

The link in the invitation email points at `/accept-invitation?token=<raw-token>`.

1. Frontend calls `GET /api/invitations/lookup?token=<raw-token>`.
   - Computes SHA-256 of the raw token and looks up by hash.
   - Returns `{ valid: true, email, role, university_name? }` for a still-pending,
     non-expired invitation.
   - Returns `{ valid: false, reason: 'invalid' | 'expired' | 'accepted' | 'revoked' }` otherwise.
2. User submits `POST /api/invitations/accept` with `{ token, name, password,
   confirm_password }`.
3. Backend revalidates the token (single read; no time-of-check race —
   acceptance is gated on a `WHERE status = 'pending'` UPDATE).
4. **Email match check:** the invitation's email is the only allowed
   account email — the user does not get to choose.
5. New `users` row inserted with the invited role and
   `status = 'active'`. Password hashed with PBKDF2.
6. Invitation row updated: `status = 'accepted'`, `accepted_at = now()`.
7. Audits: `user.created`, `invitation.accepted`.
8. `university_hub_welcome` Mailgun send + `email_logs` row.
9. Session created and cookie set, so the user lands signed in on `/app/...`.

### Resend

```
POST /api/invitations/:id/resend
```

- Actor must satisfy `canInvite` and own the invitation's scope.
- Invitation must be `pending` and **not** expired. (Expired invitations
  cannot be resurrected — admin must create a fresh invitation.)
- Rate limit: 5 resends per invitation per rolling 60 minutes
  (`INVITATION_RESEND_*` constants in `packages/shared`).
- Sends `university_hub_invitation_resend`, audits `invitation.resent`.
- On Mailgun failure, audits `invitation.email_failed` instead and
  returns `200` with `email_status: "failed"` so the UI can show a warning.

### Revoke

```
POST /api/invitations/:id/revoke
```

- Sets `status = 'revoked'`. Future acceptance attempts fail with
  `invitation_invalid`. Audit: `invitation.revoked`.
- No email is sent.

## RBAC matrix

The full set of roles (DB / API values, lowercase / snake_case):

```
super_admin, university_admin, staff, faculty, teacher,
teacher_assistant, student, guest, viewer
```

UI labels: Super Admin, University Admin, Staff, Faculty, Teacher, Teacher
Assistant, Student, Guest, Viewer.

### Scope

- `super_admin` is **unscoped** — sees and acts on every university.
- All other roles are **scoped to their `university_id`**. Cross-university
  reads/writes return `403 forbidden`. Returns `403`, never `404`, to avoid
  leaking existence.

### Who can invite whom

(Source: `rolesInvitableBy()` in `packages/shared/src/constants/invitations.ts`.)

| Actor              | May invite                                                                                            |
|--------------------|-------------------------------------------------------------------------------------------------------|
| `super_admin`      | super_admin, university_admin, staff, faculty, teacher, teacher_assistant, student, guest, viewer    |
| `university_admin` | university_admin, staff, faculty, teacher, teacher_assistant, student, guest, viewer (own uni only)   |
| any other role     | (cannot invite)                                                                                       |

### Who can manage users

(Source: `canManageUsers()` + `rolesAssignableBy()` in
`packages/shared/src/constants/users.ts`.)

| Actor              | Can manage                                                | Can promote to                                                                                      |
|--------------------|-----------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `super_admin`      | any user                                                  | any role                                                                                            |
| `university_admin` | non-admin users in their own university                   | staff, faculty, teacher, teacher_assistant, student, guest, viewer (cannot create new admins)       |
| any other role     | none                                                      | none                                                                                                |

`university_admin` cannot manage another `university_admin` (sibling
escalation), cannot manage a `super_admin` (privilege escalation), and
cannot promote anyone to `super_admin` or `university_admin`.

### Resource matrix

`R` = read, `W` = create / update, `D` = delete. "self" means the actor's
own profile only. "uni" means the actor's own university.

| Resource              | super_admin | university_admin | staff | faculty | teacher | teacher_assistant | student | guest | viewer |
|-----------------------|:-----------:|:----------------:|:-----:|:-------:|:-------:|:-----------------:|:-------:|:-----:|:------:|
| `/app/dashboard`      | R           | R                | R     | R       | R       | R                 | R       | R     | R      |
| `/app/universities`   | RWD         | R/W (own)        | R     | R       | R       | R                 | R       | —     | R      |
| `/app/users`          | RW          | RW (uni, non-admin)| R   | —       | —       | —                 | —       | —     | R      |
| `/app/invitations`    | RWD         | RWD (uni)        | —     | —       | —       | —                 | —       | —     | —      |
| `/app/departments`    | RWD         | RWD (uni)        | RW    | R       | R       | R                 | R       | —     | R      |
| `/app/courses`        | RWD         | RWD (uni)        | RW    | RW (own)| R       | R                 | R       | —     | R      |
| `/app/students`       | R           | R (uni)          | R     | R       | R       | R                 | self    | —     | R      |
| `/app/faculty`        | R           | R (uni)          | R     | self    | R       | R                 | R       | —     | R      |
| `/app/teachers`       | R           | R (uni)          | R     | R       | self    | R                 | R       | —     | R      |
| `/app/teacher-assistants` | R       | R (uni)          | R     | R       | R       | self              | R       | —     | R      |
| `/app/student/*`      | —           | —                | —     | —       | —       | —                 | self    | —     | —      |
| `/app/teacher/*`      | —           | —                | —     | —       | self    | —                 | —       | —     | —      |
| `/app/teacher-assistant/*` | —      | —                | —     | —       | —       | self              | —       | —     | —      |
| `/app/guest/dashboard`| —           | —                | —     | —       | —       | —                 | —       | self  | —      |
| `/app/audit-logs`     | R           | R (uni)          | R (uni)| —      | —       | —                 | —       | —     | —      |
| `/app/email-logs`     | R           | R (uni)          | —     | —       | —       | —                 | —       | —     | —      |
| `/app/settings`       | RW          | RW (uni)         | R     | R       | R       | R                 | R       | R     | R      |

> Cells marked "—" return `403 forbidden` from the backend. Frontend nav
> hides the corresponding entry but the Worker is the source of truth.

## Audit logging

Every sensitive action emits an `audit_logs` row via `writeAuditLog()` in
`apps/worker/src/services/audit.ts`. The full action list (matches epic §30)
is exported from `packages/shared/src/constants/audit-actions.ts`:

```
auth.sign_in              auth.sign_out
invitation.created        invitation.accepted
invitation.revoked        invitation.resent
invitation.email_failed
user.created              user.updated
user.role_changed         user.status_changed
university.created        university.updated
department.created        department.updated     department.deleted
course.created            course.updated         course.deleted
email.sent                email.failed
settings.updated
```

Each row includes `university_id` (when applicable), `actor_user_id` (null
for system actions like bootstrap), `action`, `entity_type`, `entity_id`,
and a `metadata_json` blob. Audit log writes never block the user action —
failures are logged to the Worker console and swallowed.

Read the audit log via `GET /api/audit-logs` (`super_admin`,
`university_admin`, `staff` only — see RBAC matrix). The backing UI is
`/app/audit-logs`.

## Security checklist (epic §23, §38)

- [x] Passwords hashed with PBKDF2-SHA256, never stored or logged in
      plaintext.
- [x] Session tokens hashed (SHA-256) before persistence; raw tokens only
      live in the HttpOnly cookie.
- [x] Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production
      (anything with `APP_ENV != development`).
- [x] Wrong-email and wrong-password collapse to the same generic 401.
- [x] Invitation tokens are single-use; expired / accepted / revoked
      invitations always reject.
- [x] Invitation token raw bytes are never stored — only their SHA-256.
- [x] Backend re-checks RBAC on every protected route; frontend hiding is
      convenience only.
- [x] `university_admin` cannot invite or promote to `super_admin` or
      `university_admin` — `rolesInvitableBy` / `rolesAssignableBy` enforce.
- [x] `403 Forbidden` for unauthorized actions (never `404`, which would
      leak existence).
- [x] Mailgun secrets are never returned by `/api/settings/mailgun-status`
      — only `Configured` / `Missing configuration`.
- [x] All request bodies validated with zod schemas in `packages/shared`.
- [x] Production bootstrap endpoint 404s without `BOOTSTRAP_SECRET`, 401s
      with the wrong secret, 409s once any super_admin exists.
- [x] No public registration path. Invitations are the only door.
