// Worker bindings + environment variables. Cloudflare merges `[vars]` from
// wrangler.toml, `.dev.vars` (local), and `wrangler secret put …` (prod) onto
// `env`. Values declared here are read by request handlers.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  APP_ENV?: string;
  APP_NAME?: string;
  APP_BASE_URL?: string;

  SESSION_COOKIE_NAME?: string;
  SESSION_SECRET?: string;

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
}

export function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "development") !== "development";
}
