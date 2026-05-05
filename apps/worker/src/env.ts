// Worker bindings + environment variables. Cloudflare merges `[vars]` from
// wrangler.toml, `.dev.vars` (local), and `wrangler secret put …` (prod) onto
// `env`. Values declared here are read by request handlers.

export interface Env {
  DB: D1Database;

  // R2 bucket bound by `[[r2_buckets]]` in wrangler.toml. Optional because
  // the binding is only present in deployments that opted into the in-Worker
  // cron-triggered backup path (UNI-27); the GitHub Actions backup workflow
  // does not require this binding. When unset the scheduled handler logs a
  // structured failure and exits without crashing.
  BACKUPS?: R2Bucket;

  APP_ENV?: string;
  APP_NAME?: string;
  APP_BASE_URL?: string;

  // Comma-separated list of origins allowed to call /api/* with credentials
  // (the Cloudflare Pages SPA + any local dev origins). Drives the CORS
  // middleware in utils/cors.ts. Wildcards: a leading "*." matches any
  // subdomain ("*.university-hub-v2-web.pages.dev" → preview deploys).
  ALLOWED_WEB_ORIGINS?: string;

  SESSION_COOKIE_NAME?: string;
  // HMAC-SHA-256 key used to derive `sessions.token_hash` from the raw
  // session token (UNI-37). Required at runtime: `auth/session.ts` throws
  // if this is unset on any sign-in / session-resolve path. Rotating the
  // value invalidates every outstanding session (existing `token_hash`
  // values no longer re-derive under the new key), which is the
  // sign-everyone-out lever the breach runbook calls for during
  // S0/S1 containment.
  SESSION_SECRET?: string;

  // Session lifecycle (UNI-26). Both default to spec values when unset:
  //   - idle: 30 minutes — re-auth required if there's a gap longer than this
  //     between authenticated requests.
  //   - absolute: 12 hours — re-auth required even with continuous activity.
  // Non-numeric or zero values fall back to the defaults.
  SESSION_IDLE_TIMEOUT_SECONDS?: string;     // default 1800  (30 min)
  SESSION_ABSOLUTE_TIMEOUT_SECONDS?: string; // default 43200 (12 h)

  // Cookie name for the short-lived "password verified, MFA pending"
  // challenge cookie issued by /api/auth/sign-in when a role requires MFA
  // (UNI-24). Defaults to "university_hub_mfa_challenge" if unset.
  MFA_CHALLENGE_COOKIE_NAME?: string;

  // Cookie name for the long-lived "Remember this device" trusted-device
  // cookie issued after a successful TOTP challenge (UNI-47). Defaults to
  // "university_hub_device_trust" if unset. The cookie is HttpOnly,
  // signed/HMAC'd via SESSION_SECRET (the cookie value IS the bearer
  // token; the keyed hash sits in `trusted_devices.token_hash`).
  TRUSTED_DEVICE_COOKIE_NAME?: string;

  // Mailgun (UNI-9). Secrets in production, placeholders in `.dev.vars`.
  // Missing key/domain short-circuits the email service to a "not configured"
  // failure rather than crashing — see services/mail/mailgun.ts.
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_FROM_EMAIL?: string;
  MAILGUN_FROM_NAME?: string;
  MAILGUN_REGION?: string;

  SUPPORT_EMAIL?: string;

  // Production bootstrap (UNI-16). When set, `POST /api/bootstrap/super-admin`
  // accepts an `Authorization: Bearer <BOOTSTRAP_SECRET>` request to create
  // the very first super_admin. The endpoint is auto-disabled once any
  // super_admin row exists, so the secret only confers one-shot capability;
  // unset the secret with `wrangler secret delete BOOTSTRAP_SECRET` after
  // bootstrap as defense in depth.
  BOOTSTRAP_SECRET?: string;

  // Rate-limit overrides (UNI-25). Defaults live in middleware/rate-limit.ts;
  // env vars only need to be set when an operator wants different ceilings.
  // All values are positive integers; non-numeric or zero values fall back
  // to the default.
  RATE_LIMIT_SIGN_IN_MAX?: string;                       // default 5
  RATE_LIMIT_SIGN_IN_WINDOW_SECONDS?: string;            // default 900 (15 min)
  RATE_LIMIT_PASSWORD_RESET_MAX?: string;                // default 3
  RATE_LIMIT_PASSWORD_RESET_WINDOW_SECONDS?: string;     // default 3600 (1h)
  RATE_LIMIT_MFA_CHALLENGE_MAX?: string;                 // default 5
  RATE_LIMIT_MFA_CHALLENGE_WINDOW_SECONDS?: string;      // default 300 (5 min)
  RATE_LIMIT_INVITATION_RESEND_MAX?: string;             // default 3
  RATE_LIMIT_INVITATION_RESEND_WINDOW_SECONDS?: string;  // default 3600 (1h)
  RATE_LIMIT_API_AUTH_MAX?: string;                      // default 120
  RATE_LIMIT_API_AUTH_WINDOW_SECONDS?: string;           // default 60
  RATE_LIMIT_API_ANON_MAX?: string;                      // default 30
  RATE_LIMIT_API_ANON_WINDOW_SECONDS?: string;           // default 60

  // Faculty analytics suppression threshold (UNI-31). Aggregates over fewer
  // than this many students are returned as `{ suppressed: true }` to prevent
  // re-identification in small classes. Defaults to 5 when unset; non-numeric
  // or zero values fall back to the default.
  ANALYTICS_MIN_N?: string;
  // Pass-rate threshold for course/assessment analytics, expressed as a
  // percentage of `max_score` (UNI-31). Default 60. Configurable so an
  // institution that grades on a 70% pass line can swap it without code.
  ANALYTICS_PASS_THRESHOLD_PCT?: string;

  // D1 → R2 backup overrides (UNI-27). Read by both the in-Worker cron
  // handler in services/backup.ts and (via process.env) by
  // scripts/backup-d1.mjs running on the GitHub Actions runner. Defaults
  // give 30 dailies / 12 weeklies / 6 monthlies under the `d1/` prefix.
  D1_BACKUP_BUCKET?: string;          // metadata only; binding decides target
  D1_BACKUP_PREFIX?: string;          // default: "d1"
  D1_BACKUP_RETAIN_DAILY?: string;    // default: 30
  D1_BACKUP_RETAIN_WEEKLY?: string;   // default: 12
  D1_BACKUP_RETAIN_MONTHLY?: string;  // default: 6

  // Retention sweep overrides (UNI-33). Read by services/retention.ts on
  // every nightly cron run. All values are positive integers (days);
  // non-numeric or zero values fall back to the documented default. The
  // defaults match the FERPA-aligned baseline in docs/data-retention.md.
  // Per-customer overrides go through Cloudflare env vars (`wrangler
  // secret put` for sensitive customers, `[vars]` in wrangler.toml for
  // documented overrides).
  //
  // Set RETENTION_DRY_RUN=1 to log the sweep plan without applying any
  // INSERT/DELETE — useful when first deploying to a customer with
  // pre-existing data we want to inspect before archival.
  RETENTION_DRY_RUN?: string;                          // default: unset (live)
  RETENTION_EDUCATIONAL_DAYS?: string;                 // default: 2555 (~7y)
  RETENTION_AUDIT_LOG_DAYS?: string;                   // default: 2555 (~7y)
  RETENTION_GRADE_ACCESS_LOG_DAYS?: string;            // default: 2555 (~7y)
  RETENTION_EMAIL_LOG_DAYS?: string;                   // default: 90
  RETENTION_SOFT_DELETED_DAYS?: string;                // default: 365
  RETENTION_SESSION_PURGE_DAYS?: string;               // default: 30
  RETENTION_RATE_LIMIT_PURGE_DAYS?: string;            // default: 30
  RETENTION_MFA_CHALLENGE_PURGE_DAYS?: string;         // default: 30
  RETENTION_PARENT_TOKEN_PURGE_DAYS?: string;          // default: 30
  RETENTION_PARENT_SESSION_PURGE_DAYS?: string;        // default: 30
  // Ultimate-retention windows on the archive shadow tables. Once a row's
  // `retention_archived_at` is older than the configured window it is
  // hard-deleted from the archive. Email gets the shortest window per the
  // sub-issue spec ("archived emails purged after a year"); the rest
  // default to "never auto-purge from archive" (set to a positive number
  // to opt in per customer; 0 / blank skips the sweep).
  RETENTION_ARCHIVE_EMAIL_DAYS?: string;               // default: 365
  RETENTION_ARCHIVE_AUDIT_LOG_DAYS?: string;           // default: unset (skip)
  RETENTION_ARCHIVE_GRADE_ACCESS_LOG_DAYS?: string;    // default: unset (skip)
  RETENTION_ARCHIVE_GRADES_DAYS?: string;              // default: unset (skip)
  RETENTION_ARCHIVE_ASSESSMENTS_DAYS?: string;         // default: unset (skip)
  RETENTION_ARCHIVE_COURSE_ASSIGNMENTS_DAYS?: string;  // default: unset (skip)

  // Field-level encryption master key for LMS OAuth secrets + bearer
  // tokens (UNI-51). Stored secrets in `lms_provider_configs` and
  // `lms_connections` are wrapped in AES-GCM with a per-university key
  // derived from this master via HKDF-SHA-256 (apps/worker/src/crypto/
  // field-encryption.ts). Required at runtime on any LMS code path:
  // encrypt/decrypt fail closed if unset. Rotation invalidates every
  // existing ciphertext (the runbook in docs/encryption.md walks
  // through the re-encrypt-on-next-sync convergence path).
  LMS_TOKEN_ENCRYPTION_KEY?: string;
}

export function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "development") !== "development";
}
