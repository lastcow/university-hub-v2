import type { HealthResponse } from "@university-hub/shared";

import type { Env } from "./env.js";
import { buildContext } from "./middleware/auth.js";
import { handleMe, handleSignIn, handleSignOut } from "./routes/auth.js";
import { handleCreateContactMessage } from "./routes/contact.js";
import { handleDashboardSummary } from "./routes/dashboard.js";
import { errorResponse, jsonOk } from "./utils/responses.js";

export type { Env } from "./env.js";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const ctx = await buildContext(request, env);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const body: HealthResponse = {
        ok: true,
        service: "university-hub-worker",
        timestamp: new Date().toISOString(),
      };
      return jsonOk(body);
    }

    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      return handleSignIn(ctx);
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      return handleSignOut(ctx);
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      return handleMe(ctx);
    }

    if (url.pathname === "/api/dashboard/summary" && request.method === "GET") {
      return handleDashboardSummary(ctx);
    }

    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleCreateContactMessage(ctx);
    }

    return errorResponse(404, "not_found", "The requested resource was not found.");
  },
} satisfies ExportedHandler<Env>;
