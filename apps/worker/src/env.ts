// Worker bindings + environment variables. Cloudflare merges `[vars]` from
// wrangler.toml, `.dev.vars` (local), and `wrangler secret put …` (prod) onto
// `env`. Values declared here are read by request handlers.

export interface Env {
  DB: D1Database;

  APP_ENV?: string;
  APP_NAME?: string;
  APP_BASE_URL?: string;

  // Comma-separated list of origins allowed to call /api/* with credentials
  // (the Cloudflare Pages SPA + any local dev origins). Drives the CORS
  // middleware in utils/cors.ts. Wildcards: a leading "*." matches any
  // subdomain ("*.university-hub-v2-web.pages.dev" → preview deploys).
  ALLOWED_WEB_ORIGINS?: string;

  SESSION_COOKIE_NAME?: string;
  SESSION_SECRET?: string;

  // Cookie name for the short-lived "password verified, MFA pending"
  // challenge cookie issued by /api/auth/sign-in when a role requires MFA
  // (UNI-24). Defaults to "university_hub_mfa_challenge" if unset.
  MFA_CHALLENGE_COOKIE_NAME?: string;

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
