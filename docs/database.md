# Database (Cloudflare D1)

University Hub v2 uses Cloudflare D1 — a SQLite database — bound to the Worker
as `env.DB`. All schema lives under `migrations/` at the repo root and is
applied via `wrangler d1 migrations apply DB`.

## Type conventions

D1 is SQLite under the hood, so only `TEXT`, `INTEGER`, and `REAL` are used.

| Conceptual type | SQL type | Notes                                                                 |
|-----------------|----------|-----------------------------------------------------------------------|
| UUID            | `TEXT`   | Generated in the Worker via `crypto.randomUUID()`. Stored as v4 UUID strings. |
| Timestamp       | `TEXT`   | ISO-8601 UTC, e.g. `2026-05-04T02:11:08.123Z`. Defaults are set with `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Sorts lexically. |
| Boolean         | `INTEGER`| `0` / `1`. Currently unused — status enums are `TEXT`.                |
| Enum            | `TEXT`   | Allowed values pinned via `CHECK` constraints (see schema).           |

### Why UUIDs as `TEXT` PKs?

SQLite has no native UUID type and `INTEGER PRIMARY KEY` autoincrement leaks
ordering / count information through API responses. Generating UUIDs in the
Worker keeps insert paths simple (no `RETURNING id` round-trip), makes IDs
safe to expose in URLs, and lets us mint IDs before writing (handy for
cross-table operations done in a single D1 batch).

## Foreign keys

D1 supports SQL-standard foreign-key declarations but only enforces them when
`PRAGMA foreign_keys = ON` is set on the connection. The Worker DB helper
(`apps/worker/src/db/index.ts`) sets this lazily on first use of each
`D1Database` reference, so all queries through the helper get FK enforcement.
Migrations also set the pragma at the top of each file so `wrangler d1
migrations apply` runs with FKs on.

## Password hashing

Passwords are hashed with **PBKDF2-SHA256** via the Web Crypto API. Both the
Worker (`apps/worker/src/auth/password.ts`) and the seed migration use the
same encoded format:

```
pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
```

- iterations: `100000`
- salt: 16 random bytes
- derived key: 32 bytes

To mint a new hash offline (used for the dev seed and the production bootstrap
super_admin):

```bash
node scripts/hash-password.mjs '<password>'
```

Production secrets and real user passwords go through `hashPassword()` from
the Worker auth module — never write plaintext to the database.

## Migrations

Migrations live in `migrations/` at the repo root. `apps/worker/wrangler.toml`
sets `migrations_dir = "../../migrations"` so `wrangler` picks them up from
there.

| File                              | What it does                                                                                                |
|-----------------------------------|-------------------------------------------------------------------------------------------------------------|
| `0001_initial_schema.sql`         | All core tables (users, sessions, invitations, universities, departments, courses, role profile tables, course_assignments, audit_logs, contact_messages) plus indexes from epic UNI-1 §19. |
| `0002_email_logs.sql`             | `email_logs` table for Mailgun delivery tracking + indexes.                                                 |
| `0003_seed_dev_data.sql`          | Demo university, super_admin, demo users for each role, demo departments and courses. **Dev only.**         |

### Apply migrations

From the repo root:

```bash
# Local (uses .wrangler/-backed sqlite, no Cloudflare account needed)
npm run db:migrate:local

# Production (applies against the real D1 database — QA / deploy)
npm run db:migrate
```

Under the hood these run `wrangler d1 migrations apply DB --local` /
`--remote` from the `apps/worker/` workspace. The `DB` binding is defined in
`apps/worker/wrangler.toml`.

### Seed dev data

`0003_seed_dev_data.sql` is a normal migration — applying migrations locally
seeds the dev DB. Re-running is idempotent (`INSERT OR IGNORE` on fixed UUIDs),
but `wrangler d1 migrations apply` already tracks applied migrations and
will skip files that have run.

To reset the local DB and reseed, drop the local store and re-apply:

```bash
rm -rf apps/worker/.wrangler
npm run db:migrate:local
```

### Sanity-check the local DB

```bash
npm run db:exec:local -- --command "SELECT count(*) AS n FROM users"
npm run db:exec:local -- --command "SELECT email, role FROM users ORDER BY role"
npm run db:exec:local -- --command "SELECT name FROM universities"
```

(`db:exec:local` is a thin wrapper around `wrangler d1 execute DB --local`.)

## Dev super_admin login

The seed migration creates one super_admin and one user per role. They all
share the same dev password.

| Field    | Value                  |
|----------|------------------------|
| Email    | `superadmin@dev.local` |
| Password | `DevSuperAdmin!2026`   |
| Role     | `super_admin`          |

Other dev users follow the pattern `<role>@dev.local` with the same password.
**These credentials are dev-only — never load `0003_seed_dev_data.sql` into
production.**

## Schema reference

For the canonical column list and indexes, read the migration files. The
authoritative high-level spec is epic [UNI-1](../README.md), sections 18 and
19.
