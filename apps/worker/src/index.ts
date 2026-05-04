import type { ApiResponse, HealthResponse } from "@university-hub/shared";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const body: ApiResponse<HealthResponse> = {
        ok: true,
        data: {
          ok: true,
          service: "university-hub-worker",
          timestamp: new Date().toISOString(),
        },
      };
      return Response.json(body);
    }

    if (url.pathname.startsWith("/api/")) {
      const body: ApiResponse<never> = {
        ok: false,
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
          status: 404,
        },
      };
      return Response.json(body, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
