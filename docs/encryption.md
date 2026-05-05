# Field-level encryption (UNI-51)

This document is the operator handbook for the field-level encryption
layer that wraps LMS OAuth client secrets and bearer tokens before they
land in D1.

## Why this exists

D1 is encrypted at rest by Cloudflare, but at-rest encryption only
protects against physical-disk compromise. It does NOT protect against:

- A compromised Worker secret that lets an attacker run authenticated
  D1 queries.
- A compromised Cloudflare account / API token that lets an attacker
  read tables via the dashboard or `wrangler d1 execute`.
- A subpoena or legal order that reaches D1 contents but not the
  Worker's runtime secrets.

The substrate added in UNI-51 raises the cost of any of those by adding
an application-layer envelope around the actual secret bytes. An
attacker who reads a row out of `lms_provider_configs` or
`lms_connections` only sees AES-GCM ciphertext; without the master key
plus the per-tenant binding, the bytes are useless.

## Threat model and what this does NOT defend

- **Compromise of the Worker process at runtime** — the worker holds
  the master key and decrypts tokens to call the LMS. An attacker with
  RCE on the Worker can decrypt anything. Mitigation lives at the
  Cloudflare-secret rotation tier (SESSION_SECRET, BOOTSTRAP_SECRET,
  LMS_TOKEN_ENCRYPTION_KEY), not here.
- **Misuse by application code** — anyone who can call the
  `decryptForUniversity` helper with both the right env and the right
  university id sees plaintext. RBAC for the routes that touch LMS
  state is the relevant control, not this layer.
- **Side channels in the LMS provider itself** — once the token is on
  the wire to Canvas / Blackboard / etc., this layer's job is done.

## Algorithm

`apps/worker/src/crypto/field-encryption.ts` encrypts with AES-GCM
(128-bit auth tag, 12-byte random IV per call, 256-bit key).

The per-tenant key is derived via HKDF-SHA-256 from
`LMS_TOKEN_ENCRYPTION_KEY` with the university id as both the salt and
a suffix in the info parameter:

```
key = HKDF-SHA-256(
  ikm     = utf8(LMS_TOKEN_ENCRYPTION_KEY),
  salt    = utf8(university_id),
  info    = utf8("university-hub.lms.field-encryption.v1:" + university_id),
  L       = 32 bytes,
)
```

The on-disk format is `base64(iv || ciphertext || tag)`. A leading
12-byte IV ensures the (key, IV) reuse probability is bounded by the
2⁹⁶ birthday, well below operational risk for the volume of LMS
tokens we expect to store.

## Setting the master key

The master is configured per environment:

- **Local dev**: copy `.dev.vars.example` → `.dev.vars` and set
  `LMS_TOKEN_ENCRYPTION_KEY=...`. A dev-only string is fine — the
  helper only checks that the value is non-empty.
- **Production / each customer deploy**: use Wrangler secrets.

```sh
# Generate and store
openssl rand -base64 48 | wrangler secret put LMS_TOKEN_ENCRYPTION_KEY
```

The Worker fails closed if `LMS_TOKEN_ENCRYPTION_KEY` is unset on any
LMS code path (`encryptForUniversity` / `decryptForUniversity` both
throw).

## Rotation procedure

Rotation invalidates every existing ciphertext — by design.
Pre-rotation rows in `lms_provider_configs.client_secret_encrypted`,
`lms_connections.access_token_encrypted`, and
`lms_connections.refresh_token_encrypted` no longer decrypt under the
new master.

Use this lever when:

- A Cloudflare account secret leak is suspected.
- A Worker deploy carried the master out of band (e.g. into a log).
- An operator with access to the master leaves the team.
- It is the scheduled rotation interval (we suggest annually as a
  default; faster for high-risk customers).

### Steps

1. **Pre-flight**: notify on-call. The window from step 2 to step 5 is
   "users will see a one-time reconnect prompt on their next sync".
   Schedule it outside business hours.

2. **Rotate the secret**. Generate the new master and push it as the
   active secret:

   ```sh
   openssl rand -base64 48 | wrangler secret put LMS_TOKEN_ENCRYPTION_KEY
   ```

   Do NOT delete the previous master yet — keep it in a sealed
   password-manager entry for at least the rollback window (24h
   recommended).

3. **Invalidate existing connections**. Mark every active row stale so
   the next sync forces a re-auth:

   ```sh
   wrangler d1 execute DB --remote \
     --command "UPDATE lms_connections SET status = 'expired'
                WHERE status = 'active'"
   wrangler d1 execute DB --remote \
     --command "UPDATE lms_provider_configs
                SET client_secret_encrypted = ''
                WHERE 1=1"
   ```

   The empty-string `client_secret_encrypted` is a sentinel — admin UI
   in UNI-53 surfaces "Canvas client secret needs re-entry" when it
   sees this state. Until an admin re-enters the secret, no user can
   start a sync for that provider.

4. **Convergence (user re-auth)**. The first time each user hits the
   sync UI after step 3 they see "Reconnect Canvas" because their
   `lms_connections` row is `expired`. The connect flow re-runs the
   OAuth dance and re-encrypts the new tokens under the new master.
   No code changes; the application-level state machine handles this
   case already.

5. **Post-rotation cleanup**. After the rollback window, delete the
   previous master from the password manager. There is no "decrypt
   under old key" code path; pre-rotation ciphertext that survives in
   the DB is dead bytes.

### Rollback

If step 2 succeeded but the rotation needs to be unwound (e.g. the new
secret was lost before step 3 ran), restore the previous master via
`wrangler secret put` and skip steps 3+. No data was touched yet.

If steps 3+ ran and you need to roll back, restore the previous master
AND issue a forced sign-out (clear `lms_connections`); pre-rotation
ciphertexts in `lms_provider_configs` will decrypt again, but the
expiration sentinel for users still requires them to reconnect. There
is no path that recovers user tokens once the rotation has propagated.

## What does and does not cross tenants

- The master is a single Cloudflare secret per deploy.
- The derived encryption key is bound to a specific `university_id`.
  Decrypting a row under the wrong university id fails closed (the
  AES-GCM tag check raises).
- Cross-university decryption attempts are therefore detectable in
  logs as `OperationError` exceptions from `decryptForUniversity`.
  The reconciliation engine (UNI-56) and routes that touch LMS state
  should treat any such throw as a hard failure and not retry under a
  different tenant.

## Tests

Unit tests live at
`apps/worker/test/crypto/field-encryption.test.ts` and cover:

- Round-trip happy path, empty plaintext, unicode plaintext.
- Random-IV behavior (same plaintext, different ciphertext).
- Cross-university decryption fails closed.
- Master-key rotation invalidates pre-rotation ciphertexts.
- Malformed inputs fail closed (truncated payload, garbage tag,
  non-base64).
- Missing master env var fails closed on both encrypt and decrypt.

Run them with:

```sh
npm run test --workspace=@university-hub/worker -- crypto/field-encryption
```
