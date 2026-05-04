// Cloudflare Worker entry point.
// Real routing/middleware/services land in later issues — see epic UNI-1.
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("university-hub-v2 worker: not implemented yet", {
      status: 501,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
