// Canvas OAuth helper tests (sub-issue UNI-52).
//
// All HTTP is mocked via the `FetchLike` boundary. No live HTTP.

import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "../../../src/lms/canvas/oauth.js";
import { CanvasOAuthError, USER_AGENT } from "../../../src/lms/canvas/http.js";

import { jsonResponse, loadJsonFixture, mockFetch } from "./helpers.js";

const PROVIDER_CONFIG = {
  base_url: "https://canvas.example.edu",
  client_id: "10000000000000123",
  client_secret: "fixture-canvas-client-secret",
};

describe("buildAuthorizeUrl", () => {
  it("builds a Canvas authorize URL with required params", () => {
    const url = buildAuthorizeUrl(
      PROVIDER_CONFIG,
      "state-abc",
      "https://hub.example.com/api/lms/canvas/callback",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://canvas.example.edu/login/oauth2/auth",
    );
    expect(parsed.searchParams.get("client_id")).toBe(
      "10000000000000123",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://hub.example.com/api/lms/canvas/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("scope")).toBeNull();
  });

  it("normalizes a trailing slash on base_url", () => {
    const url = buildAuthorizeUrl(
      { ...PROVIDER_CONFIG, base_url: "https://canvas.example.edu/" },
      "s",
      "https://hub.example.com/cb",
    );
    expect(url.startsWith("https://canvas.example.edu/login/oauth2/auth?")).toBe(true);
  });

  it("includes scope and purpose when provided", () => {
    const url = buildAuthorizeUrl(
      PROVIDER_CONFIG,
      "s",
      "https://hub.example.com/cb",
      {
        scopes: [
          "url:GET|/api/v1/courses",
          "url:GET|/api/v1/courses/:id/enrollments",
        ],
        purpose: "University Hub sync",
      },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe(
      "url:GET|/api/v1/courses url:GET|/api/v1/courses/:id/enrollments",
    );
    expect(parsed.searchParams.get("purpose")).toBe("University Hub sync");
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts form-encoded body to /login/oauth2/token and returns parsed tokens", async () => {
    const fixture = loadJsonFixture<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>("token-exchange.json");
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () => jsonResponse(fixture),
      },
    ]);
    const NOW = new Date("2026-05-05T04:00:00Z");

    const result = await exchangeCodeForTokens(
      PROVIDER_CONFIG,
      "auth-code-123",
      "https://hub.example.com/api/lms/canvas/callback",
      { fetchImpl: mock.fetchImpl, now: () => NOW },
    );

    expect(result.access_token).toBe(fixture.access_token);
    expect(result.refresh_token).toBe(fixture.refresh_token);
    expect(result.scope).toBe(fixture.scope);
    expect(result.expires_at).toBe(
      new Date(NOW.getTime() + 3600 * 1000).toISOString(),
    );

    const call = mock.calls[0]!;
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(headers.get("Accept")).toBe("application/json");
    const body = new URLSearchParams(call.init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(PROVIDER_CONFIG.client_id);
    expect(body.get("client_secret")).toBe(PROVIDER_CONFIG.client_secret);
    expect(body.get("redirect_uri")).toBe(
      "https://hub.example.com/api/lms/canvas/callback",
    );
    expect(body.get("code")).toBe("auth-code-123");
  });

  it("throws CanvasOAuthError with the Canvas error code on non-2xx", async () => {
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () =>
          jsonResponse(
            { error: "invalid_grant", error_description: "code expired" },
            { status: 400 },
          ),
      },
    ]);
    await expect(
      exchangeCodeForTokens(
        PROVIDER_CONFIG,
        "expired-code",
        "https://hub.example.com/cb",
        { fetchImpl: mock.fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "CanvasOAuthError",
      code: "invalid_grant",
    });
  });

  it("throws on missing access_token in a 2xx body", async () => {
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () => jsonResponse({ refresh_token: "no-access-token" }),
      },
    ]);
    await expect(
      exchangeCodeForTokens(
        PROVIDER_CONFIG,
        "code",
        "https://hub.example.com/cb",
        { fetchImpl: mock.fetchImpl },
      ),
    ).rejects.toBeInstanceOf(CanvasOAuthError);
  });

  it("treats network-layer errors as CanvasOAuthError network_error", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(
      exchangeCodeForTokens(
        PROVIDER_CONFIG,
        "code",
        "https://hub.example.com/cb",
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "CanvasOAuthError",
      code: "network_error",
    });
  });
});

describe("refreshAccessToken", () => {
  it("posts grant_type=refresh_token and returns the rotated access token", async () => {
    const NOW = new Date("2026-05-05T05:00:00Z");
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () =>
          jsonResponse({
            access_token: "atk-rotated",
            expires_in: 1800,
            // Canvas does not include refresh_token in this exchange.
          }),
      },
    ]);
    const result = await refreshAccessToken(
      PROVIDER_CONFIG,
      "rtk-prior",
      { fetchImpl: mock.fetchImpl, now: () => NOW },
    );
    expect(result.access_token).toBe("atk-rotated");
    expect(result.expires_at).toBe(
      new Date(NOW.getTime() + 1800 * 1000).toISOString(),
    );
    expect(result.scope).toBeNull();

    const body = new URLSearchParams(mock.calls[0]!.init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rtk-prior");
    expect(body.get("client_id")).toBe(PROVIDER_CONFIG.client_id);
    expect(body.get("client_secret")).toBe(PROVIDER_CONFIG.client_secret);
  });

  it("returns null expires_at when Canvas omits expires_in", async () => {
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () => jsonResponse({ access_token: "atk" }),
      },
    ]);
    const result = await refreshAccessToken(
      PROVIDER_CONFIG,
      "rtk",
      { fetchImpl: mock.fetchImpl },
    );
    expect(result.expires_at).toBeNull();
  });
});
