# Shared runtime schemas

Validators for request/response payloads that cross the network boundary.

## Choice: zod

We use [zod](https://github.com/colinhacks/zod) for runtime validation. The
worker validates every untrusted payload here so route handlers can rely on
fully-typed, normalized data, and the frontend reuses the same schemas to mirror
backend rules in forms.

Why zod over hand-rolled checks:

- Single source of truth — `z.infer<typeof Schema>` keeps the TS type and the
  runtime validator in lockstep, eliminating the drift you get with two parallel
  definitions.
- Composable — `pick`, `omit`, `extend`, and refinements let auth (UNI-6) and
  invitations (UNI-10) build narrow input shapes from one base schema.
- Tiny + edge-friendly — ships as a single ESM module with no Node-only
  dependencies, so it runs unchanged in the Cloudflare Worker.
- Friendly errors — `result.error.flatten()` maps cleanly onto the per-field
  `details` slot of `ApiError`, giving the frontend structured form errors.

Conventions:

- Schemas mirror the table shapes from epic §18, but use **camelCase** for
  request/form inputs (web idiomatic) and trust the backend to map to the
  snake_case D1 columns. Read-side response shapes stay snake_case to match the
  shared `types/` interfaces.
- Enum values come from `../constants/` so the SQL CHECK constraints, the TS
  union types, and the zod enums never drift apart.
- Keep schemas small and focused on a single endpoint. Compose, don't grow one
  mega-schema.
