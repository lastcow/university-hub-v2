/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  // Optional: when set, the API client targets this absolute URL (e.g. the
  // Cloudflare Worker host) instead of relative `/api/...` paths. Leave
  // unset in dev so the Vite proxy in vite.config.ts forwards `/api/*` to
  // the local Worker.
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
