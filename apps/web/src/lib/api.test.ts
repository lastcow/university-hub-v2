// Regression coverage for the parsed-success path of `ApiClient`.
//
// UNI-43: a Pages deploy built without `VITE_API_BASE_URL` causes
// `/api/...` calls to hit the SPA fallback and return HTML with status
// 200. Previously `parseSuccess` silently returned `undefined`, which
// let `AuthContext` mark the visitor as authenticated with no session
// user, so `AppShell` rendered `null` and the dashboard came up blank.
// The client now throws so the failure is loud.

import { describe, expect, it } from "vitest";

import { ApiClient, ApiClientError } from "./api";

interface SessionLike {
  id: string;
  email: string;
}

function makeFetch(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe("ApiClient.parseSuccess", () => {
  it("returns the parsed body for a normal application/json 200", async () => {
    const body = { id: "u_1", email: "admin@example.com" };
    const client = new ApiClient({
      fetch: makeFetch(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    const result = await client.get<SessionLike>("/api/auth/me");
    expect(result).toEqual(body);
  });

  it("unwraps a `{ data: ... }` envelope when present", async () => {
    const inner = { id: "u_2" };
    const client = new ApiClient({
      fetch: makeFetch(
        new Response(JSON.stringify({ data: inner }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    const result = await client.get<SessionLike>("/api/auth/me");
    expect(result).toEqual(inner);
  });

  it("returns undefined for a 204 No Content response", async () => {
    const client = new ApiClient({
      fetch: makeFetch(new Response(null, { status: 204 })),
    });

    const result = await client.post<void>("/api/auth/sign-out");
    expect(result).toBeUndefined();
  });

  it("throws ApiClientError when a 200 carries a non-JSON body", async () => {
    // Reproduces the UNI-43 production symptom: the SPA hit the Pages
    // SPA fallback because VITE_API_BASE_URL was unset, and the response
    // came back as text/html with a 200 status.
    const html = '<!doctype html><html><body><div id="root"></div></body></html>';
    const client = new ApiClient({
      fetch: makeFetch(
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    });

    await expect(client.get<SessionLike>("/api/auth/me")).rejects.toMatchObject({
      name: "ApiClientError",
      code: "non_json_response",
      status: 200,
    });
  });

  it("still surfaces structured errors for non-2xx JSON responses", async () => {
    const client = new ApiClient({
      fetch: makeFetch(
        new Response(
          JSON.stringify({
            error: {
              code: "unauthenticated",
              message: "Authentication required.",
              status: 401,
            },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    const error = await client
      .get<SessionLike>("/api/auth/me")
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthenticated");
  });
});
