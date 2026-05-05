import path from "node:path";
import { defineConfig, loadEnv, type Plugin, type ConfigEnv } from "vite";
import react from "@vitejs/plugin-react";

// UNI-46: production builds without `VITE_API_BASE_URL` ship a SPA that
// calls relative `/api/...` paths, which Cloudflare Pages either serves
// the SPA HTML fallback for (GET → 200 text/html) or rejects with 405
// (POST → "Method Not Allowed"). Either way sign-in is broken in
// production. Hard-fail the build if the resolved value is empty.
function requireApiBaseUrlInProduction(): Plugin {
  return {
    name: "uni46-require-api-base-url",
    apply: "build",
    config(_userConfig, env: ConfigEnv) {
      if (env.mode !== "production") return;

      const loaded = loadEnv(env.mode, process.cwd(), "VITE_");
      const value = (loaded.VITE_API_BASE_URL ?? "").trim();
      if (value.length === 0) {
        const msg =
          "[uni46] VITE_API_BASE_URL is empty for a production build. " +
          "The SPA must call the Worker origin cross-origin (Pages does " +
          "not serve /api/*). Set it in apps/web/.env.production " +
          "(default-tenant) or export it in the shell before " +
          "`npm run build` (per-tenant deploys, e.g. via " +
          "scripts/provision-university.mjs).";
        throw new Error(msg);
      }
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error("protocol must be http(s)");
        }
      } catch (cause) {
        throw new Error(
          `[uni46] VITE_API_BASE_URL is not a valid URL: ${JSON.stringify(value)}`,
          { cause },
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [requireApiBaseUrlInProduction(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
