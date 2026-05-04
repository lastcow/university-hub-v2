export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
