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

import { CanvasProvider, pickRootAccount } from "../../../src/lms/canvas/provider.js";
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
    const termsUrl =
      "https://canvas.example.edu/api/v1/accounts/self/terms?per_page=100";
    const teacherUrl =
      "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
      "&enrollment_type=teacher&per_page=100&include%5B%5D=term";
    const taUrl =
      "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
      "&enrollment_type=ta&per_page=100&include%5B%5D=term";
    const mock = mockFetch([
      {
        url: termsUrl,
        response: () => jsonResponse({ errors: ["unauthorized"] }, { status: 401 }),
      },
      {
        url: teacherUrl,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: taUrl, response: () => rawResponse("[]") },
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
  // The first URL is the account-scoped endpoint introduced in UNI-64
  // — admin-tokened callers (FSU operator) get the full course list
  // for the term from `/api/v1/accounts/self/courses?enrollment_term_id=…`.
  const ACCOUNT_COURSES_URL =
    "https://canvas.example.edu/api/v1/accounts/self/courses?enrollment_term_id=101&per_page=100" +
    "&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term";
  // User-scoped path: two parallel calls, one per enrollment type. Canvas
  // ignores the array form `enrollment_type[]`, so we issue them as
  // separate scalar requests and dedupe (UNI-67).
  const USER_COURSES_TEACHER_URL =
    "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
    "&enrollment_type=teacher&per_page=100&include%5B%5D=term";
  const USER_COURSES_TA_URL =
    "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
    "&enrollment_type=ta&per_page=100&include%5B%5D=term";

  it("hits the account-scoped courses endpoint first when the token has admin scope", async () => {
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_URL,
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
    // Verifies the account-scoped URL was called and the user-scoped
    // endpoint was NOT — the regression we're guarding against in
    // UNI-64 is silently falling through to the user-scoped path.
    expect(mock.calls[0]!.url).toBe(ACCOUNT_COURSES_URL);

    const enrollments = await provider.listEnrollments(CONNECTION, "5001");
    expect(enrollments).toHaveLength(4);
  });

  it("falls back to the user-scoped endpoint on 401 (instructor without admin scope)", async () => {
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_URL,
        response: () =>
          jsonResponse({ errors: ["unauthorized"] }, { status: 401 }),
      },
      {
        url: USER_COURSES_TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: USER_COURSES_TA_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "101");
    expect(courses).toHaveLength(2);
    expect(mock.calls.map((c) => c.url).sort()).toEqual(
      [ACCOUNT_COURSES_URL, USER_COURSES_TEACHER_URL, USER_COURSES_TA_URL].sort(),
    );
  });

  it("falls back to the user-scoped endpoint on 403 (admin scope rejected) — the FSU operator's repro path", async () => {
    // UNI-67 repro shape: account-scoped /accounts/self/courses returns
    // 403 because the FSU PAT has no admin scope on the institutional
    // root. The provider falls through to the user-scoped pair
    // (teacher + ta), which now use scalar enrollment_type and return
    // real rows instead of the silent 0/0 the array form produced.
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_URL,
        response: () => jsonResponse({ errors: ["forbidden"] }, { status: 403 }),
      },
      {
        url: USER_COURSES_TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: USER_COURSES_TA_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "101");
    expect(courses).toHaveLength(2);
  });

  it("re-throws non-401/403 failures from the account-scoped endpoint (no silent fallback on 429)", async () => {
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_URL,
        response: () => jsonResponse({}, { status: 429 }),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    await expect(
      provider.listMyCourses(CONNECTION, "101"),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // No fallback fetch was issued.
    expect(mock.calls).toHaveLength(1);
  });
});

describe("CanvasProvider.listMyCourses — account discovery fallback (UNI-66)", () => {
  // Same URLs as above, plus the discovery + retry endpoints.
  const ACCOUNT_COURSES_SELF_URL =
    "https://canvas.example.edu/api/v1/accounts/self/courses?enrollment_term_id=245&per_page=100" +
    "&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term";
  const ACCOUNTS_URL =
    "https://canvas.example.edu/api/v1/accounts?per_page=100";
  const ACCOUNT_COURSES_ROOT_URL =
    "https://canvas.example.edu/api/v1/accounts/1/courses?enrollment_term_id=245&per_page=100" +
    "&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term";
  const USER_COURSES_TEACHER_URL =
    "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
    "&enrollment_type=teacher&per_page=100&include%5B%5D=term";
  const USER_COURSES_TA_URL =
    "https://canvas.example.edu/api/v1/courses?enrollment_state=active" +
    "&enrollment_type=ta&per_page=100&include%5B%5D=term";

  it("retries with the institutional root when accounts/self/courses returns 200 + [] (FSU operator repro)", async () => {
    // The exact symptom 1 repro from the UNI-66 bug body: account-scoped
    // call against `self` returns 200 with an empty array because the
    // PAT's `self` resolves to a non-institutional context. The fix
    // discovers manageable accounts, picks the row with
    // parent_account_id === null, and retries against it.
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_SELF_URL,
        response: () => rawResponse("[]"),
      },
      {
        url: ACCOUNTS_URL,
        response: () => rawResponse(loadFixture("accounts.json")),
      },
      {
        url: ACCOUNT_COURSES_ROOT_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "245");
    expect(courses.map((c) => c.external_id)).toEqual(["5001", "5002"]);
    expect(mock.calls.map((c) => c.url)).toEqual([
      ACCOUNT_COURSES_SELF_URL,
      ACCOUNTS_URL,
      ACCOUNT_COURSES_ROOT_URL,
    ]);
  });

  // Variants of the URLs above keyed on term "101" so the user-scoped
  // fallback's client-side filter (filters by external_term_id) can
  // actually match the shared `courses-page1.json` fixture (its courses
  // are in term 101). Asserting the fallback ran AND returned rows is
  // meaningful here; the FSU-operator-repro path above uses term 245.
  const ACCOUNT_COURSES_SELF_TERM_101_URL =
    "https://canvas.example.edu/api/v1/accounts/self/courses?enrollment_term_id=101&per_page=100" +
    "&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term";

  it("falls back to user-scoped when discovery returns no manageable accounts", async () => {
    // Regular instructor on a tenant where `accounts/self/courses`
    // returns 200 + [] instead of 401 (Canvas behaviour varies on
    // non-admin tokens). `accounts` returns [] too — the user has no
    // admin scope to enumerate. Same outcome as a 401/403: drop to
    // the user-scoped surface so the SPA renders the operator's
    // personal teacher/TA enrollments instead of an empty preview.
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_SELF_TERM_101_URL,
        response: () => rawResponse("[]"),
      },
      { url: ACCOUNTS_URL, response: () => rawResponse("[]") },
      {
        url: USER_COURSES_TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: USER_COURSES_TA_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "101");
    expect(courses).toHaveLength(2);
    expect(mock.calls.map((c) => c.url).sort()).toEqual(
      [
        ACCOUNT_COURSES_SELF_TERM_101_URL,
        ACCOUNTS_URL,
        USER_COURSES_TEACHER_URL,
        USER_COURSES_TA_URL,
      ].sort(),
    );
  });

  it("falls back to user-scoped when /accounts itself 401s after empty courses", async () => {
    // Discovery 401: the token is so non-admin Canvas refuses to enumerate
    // accounts at all. We treat that the same as the original 401/403
    // path on /courses and drop down to the user-scoped surface.
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_SELF_TERM_101_URL,
        response: () => rawResponse("[]"),
      },
      {
        url: ACCOUNTS_URL,
        response: () => jsonResponse({ errors: ["unauth"] }, { status: 401 }),
      },
      {
        url: USER_COURSES_TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: USER_COURSES_TA_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "101");
    expect(courses).toHaveLength(2);
    expect(mock.calls.map((c) => c.url).sort()).toEqual(
      [
        ACCOUNT_COURSES_SELF_TERM_101_URL,
        ACCOUNTS_URL,
        USER_COURSES_TEACHER_URL,
        USER_COURSES_TA_URL,
      ].sort(),
    );
  });

  it("does not invoke discovery when the account-scoped call already returned rows (the common admin path)", async () => {
    // Guard the regression: the FSU operator's term *did* return rows
    // for the user before the bug; we don't want a perf hit on the
    // happy path. One round-trip, no /accounts probe.
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_SELF_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "245");
    expect(courses).toHaveLength(2);
    expect(mock.calls).toHaveLength(1);
  });

  it("returns 4 term-245 teacher courses for the FSU operator's PAT (UNI-67 repro)", async () => {
    // The exact FSU operator's repro path:
    //   1. /accounts/self/courses?... → 403 (PAT has no admin scope on
    //      the institutional root — confirmed against
    //      https://frostburg.instructure.com).
    //   2. Fall through to the user-scoped pair (teacher + ta).
    //   3. /courses?enrollment_type=teacher returns the user's full
    //      teaching list across all terms (5 courses in this fixture,
    //      4 of them in term 245).
    //   4. /courses?enrollment_type=ta returns [] (operator has no
    //      TA enrollments).
    //   5. Provider filters client-side to term 245 → 4 courses.
    //
    // The pre-fix shape sent `enrollment_role[]=TeacherEnrollment`
    // (array form), which Canvas's user-scoped /courses silently
    // ignores — returning [] for the FSU PAT and producing the 0/0
    // preview the user reported.
    const ACCOUNT_COURSES_SELF_245 =
      "https://canvas.example.edu/api/v1/accounts/self/courses?enrollment_term_id=245&per_page=100" +
      "&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term";
    const mock = mockFetch([
      {
        url: ACCOUNT_COURSES_SELF_245,
        response: () =>
          jsonResponse({ errors: ["forbidden"] }, { status: 403 }),
      },
      {
        url: USER_COURSES_TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-fsu-teacher.json")),
      },
      { url: USER_COURSES_TA_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "245");
    expect(courses.map((c) => c.external_id)).toEqual([
      "33226",
      "33228",
      "33230",
      "33232",
    ]);
    // Discovery is NOT consulted in this path — we 403'd straight to
    // user-scoped, so /accounts must not have been hit.
    expect(mock.calls.map((c) => c.url)).not.toContain(
      "https://canvas.example.edu/api/v1/accounts?per_page=100",
    );
  });

  it("returns the empty array unchanged when discovery's root account is also empty (genuinely zero courses for the term)", async () => {
    // True-zero case: term has no courses anywhere. Discovery finds the
    // root, retry returns []. We return [] and don't re-attempt against
    // the user-scoped path — that would be inflation: returning the
    // operator's *personal* enrollments when they asked for the term's
    // course list.
    const mock = mockFetch([
      { url: ACCOUNT_COURSES_SELF_URL, response: () => rawResponse("[]") },
      {
        url: ACCOUNTS_URL,
        response: () => rawResponse(loadFixture("accounts.json")),
      },
      { url: ACCOUNT_COURSES_ROOT_URL, response: () => rawResponse("[]") },
    ]);
    const provider = new CanvasProvider({ fetchImpl: mock.fetchImpl });
    const courses = await provider.listMyCourses(CONNECTION, "245");
    expect(courses).toEqual([]);
    expect(mock.calls).toHaveLength(3);
  });
});

describe("pickRootAccount", () => {
  it("returns null when no accounts are manageable", () => {
    expect(pickRootAccount([])).toBeNull();
  });

  it("prefers the row with parent_account_id === null (institutional root)", () => {
    expect(
      pickRootAccount([
        { id: "42", name: "Sub", parent_account_id: "1" },
        { id: "1", name: "Root", parent_account_id: null },
      ]),
    ).toBe("1");
  });

  it("falls back to the first row when no parentless account is present (sub-account admin)", () => {
    expect(
      pickRootAccount([
        { id: "42", name: "Sub A", parent_account_id: "1" },
        { id: "43", name: "Sub B", parent_account_id: "1" },
      ]),
    ).toBe("42");
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
