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
}

export function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "development") !== "development";
}
