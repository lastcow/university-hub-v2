# Mailgun templates (source of truth)

The HTML in this directory is the **canonical source** for every transactional
email University Hub sends. Mailgun stores a copy on the `retrocow.io` account
so the Worker can render and deliver them by name &mdash; the dashboard copy
is downstream of this repo.

## Layout

```
mailgun_templates/
  university_hub_<name>/
    index.html   # HTML body uploaded to Mailgun (Handlebars: {{var}})
    index.txt    # plaintext fallback (kept in repo; see "plaintext" below)
    meta.json    # description + tags + variable contract
```

The directory name is the Mailgun template name &mdash; the Worker references
it from `packages/shared/src/constants/mailgun.ts`.

## Authoring

- Single column, ~600px max width, table-based layout for email-client
  compatibility.
- Inline styles only (no `<style>` blocks, no external CSS).
- Use Handlebars-style variables: `{{recipient_name}}`. The variable contract
  per template lives in `meta.json` and `docs/mailgun.md`.
- Match the `/app` shell visual language &mdash; neutral palette, calm
  typography, rounded buttons, zinc-toned borders.

## Sync to Mailgun

```bash
npm run sync:mailgun-templates
```

Reads every directory under `mailgun_templates/`, then for each one:

- Creates the template on Mailgun if it doesn't exist yet.
- Compares the local HTML against the active version on Mailgun. If different,
  uploads a new version and marks it active. If identical, reports
  `unchanged` and makes no API calls beyond the comparison fetch.

The script is idempotent &mdash; safe to re-run after every edit.

Required env vars (read from `apps/worker/.dev.vars` or the process
environment): `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, optionally
`MAILGUN_REGION` (`US` default, `EU` flips the API base).

## Plaintext

`index.txt` is the human-authored plaintext alternative. It is **not** uploaded
to Mailgun &mdash; Mailgun stored templates only carry an HTML body. The file
is committed so:

- Future Worker changes can read it and pass it as `text=` on the message
  send (Mailgun supports `html` + `text` together for richer fallbacks).
- It documents the intended plain-text rendering for code review.

Today's deliveries rely on Mailgun's HTML rendering only; mail clients that
strip HTML will still see a basic readable body via the email's auto-text or
the user's reader app.
