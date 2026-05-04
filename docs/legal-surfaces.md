# Privacy policy + Terms of Service surfaces

Status: shipped in [UNI-34](https://github.com/lastcow/university-hub-v2/issues).

This document is the operator-facing reference for the legal surfaces
exposed by University Hub. The customer (university) owns the final
text; the platform provides defaults, an admin editor, the public
render, the acknowledgment flow at sign-up, and the re-acceptance gate
when the text changes.

## Surfaces

| Surface | Route | Audience | Notes |
| --- | --- | --- | --- |
| Privacy Policy | `/privacy` | Public | Falls back to global default if no per-customer override exists. |
| Terms of Service | `/terms` | Public | Same fallback rule. |
| Sign-up acknowledgment | `/accept-invitation` | Invited user | Checkbox blocks form submission until checked; backend stamps `users.terms_accepted_at` + `terms_accepted_version` on accept. |
| Re-acceptance gate | Any `/app/*` route | Authenticated user | Modal on `AppShell` mount; appears whenever the user's stamped version is below the current ToS version. |
| Legal admin | `/app/settings` → Legal card | super_admin / university_admin | Edit body markdown for terms & privacy; toggle "Bump version" to force re-acceptance. |
| Account-tab links | `/app/settings` → Account card | Any signed-in user | Reciprocal links to `/privacy`, `/terms`, and the FERPA disclosure surface for the user. |

## Defaults vs. customer overrides

The `legal_documents` table holds two sets of rows:

- **Customer rows** — `university_id IS NOT NULL`, one row per
  `(university_id, kind)`. Saved via `PATCH /api/legal/admin/:kind`.
- **Global default rows** — `university_id IS NULL`, one row per kind.
  Editable by `super_admin` only.

Resolution order (in `apps/worker/src/routes/legal.ts → resolveDocument`):

1. customer override for the requested university, if any
2. global default row, if any
3. seeded boilerplate from `apps/worker/src/services/legal-defaults.ts`
   (used until any admin saves anything)

## Versioning + re-acceptance

Every save records the `body_md`. Saves with `version_bump=true`
increment `version`; saves without leave it. Users carry a
`terms_accepted_version` on their `users` row; the in-app gate
(`apps/web/src/app/LegalAcknowledgmentGate.tsx`) re-prompts them
whenever `accepted < current`.

Concretely:

- Typo fix → save **without** version bump; no user is interrupted.
- Material change → save **with** version bump; every user is asked
  to re-acknowledge on the next page load.

The acknowledgment endpoint refuses with `409 version_mismatch` if the
client posts an outdated version (a stale tab POSTing for a version
the user didn't actually see); the SPA refreshes the gate and shows
the current text.

## Placeholders

The boilerplate templates `{{university_name}}` and `{{contact_email}}`
at render time. These render as:

| Placeholder | Source | Fallback |
| --- | --- | --- |
| `{{university_name}}` | `universities.name` of the row's `university_id` | "your university" |
| `{{contact_email}}` | `SUPPORT_EMAIL` env var | "your university registrar" |

When a customer pastes the boilerplate into the Legal tab as a starting
point and edits, they can keep using the same placeholders — they are
substituted on read regardless of who saved the document.

## API surface

All endpoints live under `/api/legal/`:

```
GET   /api/legal/:kind                  Public — current ToS / Privacy
                                         body. Optional ?university_id=
                                         or ?token= scopes the lookup.
GET   /api/legal/acknowledgment-status  Authed — has the calling user
                                         accepted the current version?
POST  /api/legal/accept                 Authed — record acceptance.
                                         Body: { terms_version,
                                                 privacy_version }.
GET   /api/legal/admin                  Admin — both kinds + body for
                                         the actor's university.
PATCH /api/legal/admin/:kind            Admin — save body, optional
                                         version bump.
```

## Audit trail

| Action | Written by | Includes |
| --- | --- | --- |
| `legal.terms_accepted` | Invitation accept + in-app gate | terms_version, privacy_version, source |
| `legal.document_updated` | Admin save | kind, version, version_bumped, body_changed, scope |

Existing roles (`super_admin`, `university_admin`) and the existing
`audit_logs` view (`/app/audit-logs`) surface these without further
configuration.

## What is intentionally NOT here

- **Lawyer-reviewed final text.** The boilerplate is FERPA-aligned but
  is a starting point only; customers must have their own counsel
  review before going live (called out in the issue).
- **Multi-language support.** Single English source today.
- **Cookie banner.** First-party session cookies only — no third-party
  tracking on the public pages.
- **Versions history table.** Each save bumps `version` in place. The
  audit trail (`legal.document_updated` rows in `audit_logs`) is the
  durable record of who changed what when.
- **Per-user retention overrides** for the acknowledgment record. The
  `terms_accepted_*` columns ride along with the user; archival of the
  user record archives the acknowledgment with it.
