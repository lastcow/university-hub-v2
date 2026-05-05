// CanvasProvider tests (sub-issue UNI-52; reshaped in UNI-63 to drop
// the OAuth refresh path). Covers the LmsProvider interface surface —
// authenticate, listTerms, listMyCourses, listEnrollments — composed
// against the same FetchLike mock used by api tests.

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
  mockFetch,
  rawResponse,
} from "./helpers.js";

const PROVIDER_CONFIG: LmsProviderConfig = {
  id: "cfg-1" as never,
  university_id: "uni-1" as never,
  provider_id: "canvas",
  base_url: "https://canvas.example.edu",
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
  base_url: "https://canvas.example.edu",
  access_token: "atk-fixture",
  status: "active",
  last_synced_at: null,
  created_at: "2026-05-05T03:00:00Z" as IsoDateString,
  updated_at: "2026-05-05T03:00:00Z" as IsoDateString,
};

describe("CanvasProvider.authenticate", () => {
  it("validates the PAT against /api/v1/users/self and returns a connection", async () => {
    const mock = mockFetch([
      {
        method: "GET",
        url: "https://canvas.example.edu/api/v1/users/self",
        response: () =>
          jsonResponse({ id: 4242, name: "Bob the Tester" }),
      },
    ]);
    const NOW = new Date("2026-05-05T04:00:00Z");
    const provider = new CanvasProvider({
      fetchImpl: mock.fetchImpl,
      now: () => NOW,
    });

    const conn = await provider.authenticate(
      { personal_access_token: "canvas-pat-do-not-leak" },
      PROVIDER_CONFIG,
    );

    expect(conn.provider_id).toBe("canvas");
    expect(conn.base_url).toBe(PROVIDER_CONFIG.base_url);
    expect(conn.university_id).toBe(PROVIDER_CONFIG.university_id);
    expect(conn.access_token).toBe("canvas-pat-do-not-leak");
    expect(conn.status).toBe("active");
    // Caller (route handler) is responsible for assigning these:
    expect(conn.id).toBe("");
    expect(conn.user_id).toBe("");
    expect(conn.created_at).toBe(NOW.toISOString());
    expect(conn.updated_at).toBe(NOW.toISOString());
    // Authorization header carried the PAT verbatim.
    expect(mock.calls).toHaveLength(1);
    expect(
      (mock.calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer canvas-pat-do-not-leak");
  });

  it("rejects when Canvas returns 401 (invalid PAT)", async () => {
    const mock = mockFetch([
      {
        method: "GET",
        url: "https://canvas.example.edu/api/v1/users/self",
        response: () => jsonResponse({ errors: ["unauthorized"] }, { status: 401 }),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    await expect(
      provider.authenticate(
        { personal_access_token: "bad-token" },
        PROVIDER_CONFIG,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects when no PAT is supplied", async () => {
    const provider = new CanvasProvider();
    await expect(
      provider.authenticate(
        {} as unknown as { personal_access_token: string },
        PROVIDER_CONFIG,
      ),
    ).rejects.toThrow(/personal_access_token/);
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
