// CanvasProvider tests (sub-issue UNI-52). Covers the LmsProvider
// interface surface — authenticate, refreshToken, listTerms,
// listMyCourses, listEnrollments — composed against the same
// FetchLike mock used by oauth/api tests.

import { describe, expect, it } from "vitest";

import type {
  IsoDateString,
  LmsConnection,
  LmsProviderConfig,
} from "@university-hub/shared";

import { CanvasProvider } from "../../../src/lms/canvas/provider.js";
import {
  LmsProviderRegistry,
  lmsProviderRegistry,
} from "../../../src/lms/registry.js";

import {
  jsonResponse,
  loadFixture,
  loadJsonFixture,
  mockFetch,
  rawResponse,
} from "./helpers.js";

const PROVIDER_CONFIG: LmsProviderConfig = {
  id: "cfg-1" as never,
  university_id: "uni-1" as never,
  provider_id: "canvas",
  base_url: "https://canvas.example.edu",
  client_id: "10000000000000123",
  client_secret: "fixture-canvas-client-secret",
  enabled: true,
  configured_by_user_id: null,
  configured_at: "2026-05-01T00:00:00Z" as IsoDateString,
  updated_at: "2026-05-01T00:00:00Z" as IsoDateString,
};

const CONNECTION: LmsConnection = {
  id: "conn-1" as never,
  user_id: "user-1" as never,
  university_id: "uni-1" as never,
  provider_id: "canvas",
  auth_method: "oauth",
  base_url: "https://canvas.example.edu",
  access_token: "atk-fixture",
  refresh_token: "rtk-fixture",
  token_expires_at: "2026-05-05T05:00:00Z" as IsoDateString,
  scope: null,
  status: "active",
  last_synced_at: null,
  created_at: "2026-05-05T03:00:00Z" as IsoDateString,
  updated_at: "2026-05-05T03:00:00Z" as IsoDateString,
};

describe("CanvasProvider.authenticate", () => {
  it("exchanges the code and returns a connection with provider-derived fields", async () => {
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () => rawResponse(loadFixture("token-exchange.json")),
      },
    ]);
    const NOW = new Date("2026-05-05T04:00:00Z");
    const provider = new CanvasProvider({
      fetchImpl: mock.fetchImpl,
      now: () => NOW,
    });

    const conn = await provider.authenticate(
      {
        code: "auth-code-xyz",
        redirect_uri: "https://hub.example.com/cb",
      },
      PROVIDER_CONFIG,
    );

    const fixture = loadJsonFixture<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>("token-exchange.json");

    expect(conn.provider_id).toBe("canvas");
    expect(conn.base_url).toBe(PROVIDER_CONFIG.base_url);
    expect(conn.university_id).toBe(PROVIDER_CONFIG.university_id);
    expect(conn.access_token).toBe(fixture.access_token);
    expect(conn.refresh_token).toBe(fixture.refresh_token);
    expect(conn.scope).toBe(fixture.scope);
    expect(conn.token_expires_at).toBe(
      new Date(NOW.getTime() + fixture.expires_in * 1000).toISOString(),
    );
    expect(conn.status).toBe("active");
    expect(conn.auth_method).toBe("oauth");
    // Caller (UNI-54) is responsible for assigning these:
    expect(conn.id).toBe("");
    expect(conn.user_id).toBe("");
    expect(conn.created_at).toBe(NOW.toISOString());
    expect(conn.updated_at).toBe(NOW.toISOString());
  });

  it("returns a PAT-flavored connection when personal_access_token is supplied (no HTTP)", async () => {
    // No fetch handlers — the PAT path must NOT hit the network.
    const mock = mockFetch([]);
    const NOW = new Date("2026-05-05T04:30:00Z");
    const provider = new CanvasProvider({
      fetchImpl: mock.fetchImpl,
      now: () => NOW,
    });

    const conn = await provider.authenticate(
      { personal_access_token: "canvas-pat-do-not-leak" },
      PROVIDER_CONFIG,
    );

    expect(conn.auth_method).toBe("pat");
    expect(conn.access_token).toBe("canvas-pat-do-not-leak");
    expect(conn.refresh_token).toBeNull();
    expect(conn.token_expires_at).toBeNull();
    expect(conn.scope).toBeNull();
    expect(conn.status).toBe("active");
    expect(conn.provider_id).toBe("canvas");
    expect(conn.base_url).toBe(PROVIDER_CONFIG.base_url);
    expect(conn.university_id).toBe(PROVIDER_CONFIG.university_id);
    expect(conn.created_at).toBe(NOW.toISOString());
    expect(mock.calls).toHaveLength(0);
  });

  it("prefers PAT over OAuth code when both are supplied", async () => {
    // If a caller (mistakenly) sends both, PAT wins — the OAuth dance
    // would reach over the network unnecessarily otherwise.
    const mock = mockFetch([]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const conn = await provider.authenticate(
      {
        code: "ignored",
        redirect_uri: "https://hub.example.com/cb",
        personal_access_token: "pat-wins",
      },
      PROVIDER_CONFIG,
    );
    expect(conn.auth_method).toBe("pat");
    expect(conn.access_token).toBe("pat-wins");
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects when no credentials of any kind are supplied", async () => {
    const provider = new CanvasProvider();
    await expect(
      provider.authenticate({}, PROVIDER_CONFIG),
    ).rejects.toThrow(/personal_access_token.*code.*redirect_uri/s);
  });
});

describe("CanvasProvider.refreshToken", () => {
  it("requires a loadProviderConfig dep", async () => {
    const provider = new CanvasProvider();
    await expect(provider.refreshToken(CONNECTION)).rejects.toThrow(
      /loadProviderConfig/,
    );
  });

  it("rotates the access token and preserves the refresh_token", async () => {
    const NOW = new Date("2026-05-05T05:30:00Z");
    const mock = mockFetch([
      {
        method: "POST",
        url: "https://canvas.example.edu/login/oauth2/token",
        response: () =>
          jsonResponse({
            access_token: "atk-rotated",
            expires_in: 3600,
          }),
      },
    ]);
    const provider = new CanvasProvider({
      fetchImpl: mock.fetchImpl,
      now: () => NOW,
      loadProviderConfig: async (universityId) => {
        expect(universityId).toBe(CONNECTION.university_id);
        return PROVIDER_CONFIG;
      },
    });

    const refreshed = await provider.refreshToken(CONNECTION);

    expect(refreshed.access_token).toBe("atk-rotated");
    expect(refreshed.refresh_token).toBe(CONNECTION.refresh_token);
    expect(refreshed.token_expires_at).toBe(
      new Date(NOW.getTime() + 3600 * 1000).toISOString(),
    );
    expect(refreshed.status).toBe("active");
    expect(refreshed.updated_at).toBe(NOW.toISOString());
    // Unchanged fields pass through.
    expect(refreshed.id).toBe(CONNECTION.id);
    expect(refreshed.user_id).toBe(CONNECTION.user_id);
  });

  it("rejects when the connection has no refresh_token", async () => {
    const provider = new CanvasProvider({
      loadProviderConfig: async () => PROVIDER_CONFIG,
    });
    await expect(
      provider.refreshToken({ ...CONNECTION, refresh_token: null }),
    ).rejects.toThrow(/refresh_token/);
  });

  it("rejects PAT connections — they don't refresh, the user re-pastes", async () => {
    const provider = new CanvasProvider({
      loadProviderConfig: async () => PROVIDER_CONFIG,
    });
    await expect(
      provider.refreshToken({
        ...CONNECTION,
        auth_method: "pat",
        refresh_token: null,
        token_expires_at: null,
      }),
    ).rejects.toThrow(/PAT/);
  });
});

describe("CanvasProvider.listTerms", () => {
  it("calls the accounts/self/terms endpoint and returns mapped rows", async () => {
    const mock = mockFetch([
      {
        url: "https://canvas.example.edu/api/v1/accounts/self/terms?per_page=100",
        response: () => rawResponse(loadFixture("terms.json")),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const terms = await provider.listTerms(CONNECTION);
    expect(terms.map((t) => t.external_id)).toEqual(["101", "102", "103"]);
  });

  it("falls back to course-derived terms on 401 (instructor without account scope)", async () => {
    const url1 =
      "https://canvas.example.edu/api/v1/accounts/self/terms?per_page=100";
    const url2 =
      "https://canvas.example.edu/api/v1/courses?enrollment_state=active&per_page=100" +
      "&enrollment_role%5B%5D=TeacherEnrollment&enrollment_role%5B%5D=TaEnrollment&include%5B%5D=term";
    const mock = mockFetch([
      {
        url: url1,
        response: () => jsonResponse({ errors: ["unauthorized"] }, { status: 401 }),
      },
      {
        url: url2,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const terms = await provider.listTerms(CONNECTION);
    expect(terms).toEqual([
      {
        external_id: "101",
        name: "Fall 2025",
        start_date: "2025-08-25T00:00:00Z",
        end_date: "2025-12-15T00:00:00Z",
      },
    ]);
  });

  it("re-throws on non-401/403 errors (e.g. 429 rate limit)", async () => {
    const mock = mockFetch([
      {
        url: "https://canvas.example.edu/api/v1/accounts/self/terms?per_page=100",
        response: () => jsonResponse({}, { status: 429 }),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    await expect(provider.listTerms(CONNECTION)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});

describe("CanvasProvider.listMyCourses + listEnrollments", () => {
  it("delegates to the api helpers with connection's base_url and token", async () => {
    const url1 =
      "https://canvas.example.edu/api/v1/courses?enrollment_state=active&per_page=100" +
      "&enrollment_role%5B%5D=TeacherEnrollment&enrollment_role%5B%5D=TaEnrollment&include%5B%5D=term";
    const mock = mockFetch([
      {
        url: url1,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      {
        url: (u) =>
          u.startsWith(
            "https://canvas.example.edu/api/v1/courses/5001/enrollments?",
          ),
        response: () => rawResponse(loadFixture("enrollments.json")),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });

    const courses = await provider.listMyCourses(CONNECTION, "101");
    expect(courses).toHaveLength(2);

    const enrollments = await provider.listEnrollments(CONNECTION, "5001");
    expect(enrollments).toHaveLength(4);
  });
});

describe("CanvasProvider registration", () => {
  it("registers the default Canvas provider on the singleton on import", () => {
    expect(lmsProviderRegistry.ids()).toContain("canvas");
    const canvas = lmsProviderRegistry.require("canvas");
    expect(canvas).toBeInstanceOf(CanvasProvider);
    expect(canvas.id).toBe("canvas");
  });

  it("can be constructed against a fresh registry without touching the singleton", () => {
    const local = new LmsProviderRegistry();
    const fresh = new CanvasProvider();
    local.register(fresh);
    expect(local.get("canvas")).toBe(fresh);
    // The singleton's instance is independent of the local registry.
    expect(lmsProviderRegistry.get("canvas")).not.toBe(fresh);
  });
});
