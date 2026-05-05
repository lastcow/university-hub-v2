// Canvas REST client tests (sub-issue UNI-52). All HTTP via FetchLike
// mock; fixture JSON in ./fixtures/.

import { describe, expect, it } from "vitest";

import {
  deriveTermsFromCourses,
  listAccountCoursesForTerm,
  listEnrollments,
  listManageableAccounts,
  listMyCourses,
  listTerms,
} from "../../../src/lms/canvas/api.js";
import { CanvasApiError, USER_AGENT } from "../../../src/lms/canvas/http.js";
import { parseNextLink } from "../../../src/lms/canvas/http.js";

import {
  jsonResponse,
  loadFixture,
  mockFetch,
  rawResponse,
} from "./helpers.js";

const BASE = "https://canvas.example.edu";
const TOKEN = "atk-fixture";

describe("parseNextLink", () => {
  it("returns the rel=\"next\" url when present", () => {
    const header =
      '<https://canvas.example.edu/api/v1/courses?page=1>; rel="current", ' +
      '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next", ' +
      '<https://canvas.example.edu/api/v1/courses?page=3>; rel="last"';
    expect(parseNextLink(header)).toBe(
      "https://canvas.example.edu/api/v1/courses?page=2",
    );
  });

  it("returns null when no next link is present", () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(
      parseNextLink('<https://x.example/foo>; rel="last"'),
    ).toBeNull();
  });

  it("accepts unquoted rel=next", () => {
    const header = "<https://x.example/foo?page=2>; rel=next";
    expect(parseNextLink(header)).toBe("https://x.example/foo?page=2");
  });
});

describe("listTerms", () => {
  it("returns mapped LmsTerm[] from the enrollment_terms wrapper", async () => {
    const url = `${BASE}/api/v1/accounts/self/terms?per_page=100`;
    const mock = mockFetch([
      {
        url,
        response: () => rawResponse(loadFixture("terms.json")),
      },
    ]);
    const result = await listTerms(BASE, TOKEN, { fetchImpl: mock.fetchImpl });
    expect(result).toEqual([
      {
        external_id: "101",
        name: "Fall 2025",
        start_date: "2025-08-25T00:00:00Z",
        end_date: "2025-12-15T00:00:00Z",
      },
      {
        external_id: "102",
        name: "Spring 2026",
        start_date: "2026-01-15T00:00:00Z",
        end_date: "2026-05-15T00:00:00Z",
      },
      {
        external_id: "103",
        name: "Default Term",
        start_date: null,
        end_date: null,
      },
    ]);

    const headers = new Headers(mock.calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("respects a custom accountId", async () => {
    const url = `${BASE}/api/v1/accounts/9999/terms?per_page=100`;
    const mock = mockFetch([
      {
        url,
        response: () => jsonResponse({ enrollment_terms: [] }),
      },
    ]);
    const result = await listTerms(BASE, TOKEN, {
      fetchImpl: mock.fetchImpl,
      accountId: "9999",
    });
    expect(result).toEqual([]);
  });

  it("throws CanvasApiError with status=401 on unauthorized", async () => {
    const mock = mockFetch([
      {
        url: `${BASE}/api/v1/accounts/self/terms?per_page=100`,
        response: () => jsonResponse({ errors: ["nope"] }, { status: 401 }),
      },
    ]);
    await expect(
      listTerms(BASE, TOKEN, { fetchImpl: mock.fetchImpl }),
    ).rejects.toMatchObject({
      name: "CanvasApiError",
      status: 401,
      code: "unauthorized",
    });
  });

  it("throws CanvasApiError with status=429 on rate limit", async () => {
    const mock = mockFetch([
      {
        url: `${BASE}/api/v1/accounts/self/terms?per_page=100`,
        response: () => jsonResponse({}, { status: 429 }),
      },
    ]);
    await expect(
      listTerms(BASE, TOKEN, { fetchImpl: mock.fetchImpl }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("throws CanvasApiError on malformed JSON", async () => {
    const mock = mockFetch([
      {
        url: `${BASE}/api/v1/accounts/self/terms?per_page=100`,
        response: () =>
          new Response("<!doctype html><html>...", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      },
    ]);
    await expect(
      listTerms(BASE, TOKEN, { fetchImpl: mock.fetchImpl }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });
});

describe("listMyCourses", () => {
  // The user-scoped path issues TWO calls (teacher + ta) since Canvas
  // only accepts a scalar `enrollment_type`; the array form returns 0
  // (UNI-67 root cause). Tests assert both calls fire.
  const TEACHER_URL =
    `${BASE}/api/v1/courses?enrollment_state=active&enrollment_type=teacher` +
    `&per_page=100&include%5B%5D=term`;
  const TA_URL =
    `${BASE}/api/v1/courses?enrollment_state=active&enrollment_type=ta` +
    `&per_page=100&include%5B%5D=term`;

  it("paginates via the Link header on the teacher call and filters to the requested term", async () => {
    const teacherUrl2 = `${BASE}/api/v1/courses?page=bookmark%3Adef&per_page=100`;
    const mock = mockFetch([
      {
        url: TEACHER_URL,
        response: () =>
          rawResponse(loadFixture("courses-page1.json"), {
            linkHeader: `<${teacherUrl2}>; rel="next"`,
          }),
      },
      {
        url: teacherUrl2,
        response: () => rawResponse(loadFixture("courses-page2.json")),
      },
      { url: TA_URL, response: () => rawResponse("[]") },
    ]);

    const fall = await listMyCourses(BASE, TOKEN, "101", {
      fetchImpl: mock.fetchImpl,
    });
    expect(fall.map((c) => c.external_id)).toEqual(["5001", "5002"]);
    expect(fall[0]).toEqual({
      external_id: "5001",
      external_term_id: "101",
      name: "Intro to Computer Science",
      code: "CS-101-2025F",
      description: "First course in the CS sequence.",
    });
    // teacher (page1) → teacher (page2) → ta. Order isn't strict because
    // the two type-calls go in parallel; assert all three URLs were hit.
    expect(mock.calls.map((c) => c.url).sort()).toEqual(
      [TEACHER_URL, teacherUrl2, TA_URL].sort(),
    );
  });

  it("returns empty array when no courses match the requested term", async () => {
    const mock = mockFetch([
      {
        url: TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: TA_URL, response: () => rawResponse("[]") },
    ]);
    const result = await listMyCourses(BASE, TOKEN, "999", {
      fetchImpl: mock.fetchImpl,
    });
    expect(result).toEqual([]);
  });

  it("merges teacher + ta enrollments and dedupes by external course id", async () => {
    // A user who is both Teacher and TA on the same course (rare but
    // legal) should see the course exactly once.
    const teacherCourse = {
      id: 5500,
      name: "Cross-Listed Seminar",
      course_code: "SEM-500",
      enrollment_term_id: 101,
      term: { id: 101, name: "Fall 2025", start_at: null, end_at: null },
      workflow_state: "available",
    };
    const mock = mockFetch([
      { url: TEACHER_URL, response: () => rawResponse(JSON.stringify([teacherCourse])) },
      {
        url: TA_URL,
        // Same course id appears in TA list too.
        response: () => rawResponse(JSON.stringify([teacherCourse])),
      },
    ]);
    const out = await listMyCourses(BASE, TOKEN, "101", {
      fetchImpl: mock.fetchImpl,
    });
    expect(out.map((c) => c.external_id)).toEqual(["5500"]);
  });

  it("regression — does NOT use the array form `enrollment_role[]` that Canvas silently ignores", async () => {
    // UNI-67 root cause: the deployed adapter sent
    //   `?enrollment_role[]=TeacherEnrollment&enrollment_role[]=TaEnrollment`
    // and Canvas's user-scoped /courses returned 200 + [] for the FSU
    // operator's PAT. This guards us from regressing back to that
    // shape — the URL must use scalar `enrollment_type`, never an
    // array role parameter.
    const mock = mockFetch([
      { url: TEACHER_URL, response: () => rawResponse("[]") },
      { url: TA_URL, response: () => rawResponse("[]") },
    ]);
    await listMyCourses(BASE, TOKEN, "101", { fetchImpl: mock.fetchImpl });
    for (const call of mock.calls) {
      expect(call.url).not.toContain("enrollment_role%5B%5D");
      expect(call.url).not.toContain("enrollment_role[]");
      expect(call.url).not.toContain("enrollment_type%5B%5D");
      expect(call.url).not.toContain("enrollment_type[]");
    }
  });
});

describe("listAccountCoursesForTerm", () => {
  it("hits the account-scoped endpoint with the numeric term id", async () => {
    const url =
      `${BASE}/api/v1/accounts/self/courses?enrollment_term_id=101&per_page=100` +
      `&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term`;
    const mock = mockFetch([
      {
        url,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
    ]);
    const result = await listAccountCoursesForTerm(BASE, TOKEN, "101", {
      fetchImpl: mock.fetchImpl,
    });
    expect(result.map((c) => c.external_id)).toEqual(["5001", "5002"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe(url);
  });

  it("respects a custom accountId", async () => {
    const url =
      `${BASE}/api/v1/accounts/9999/courses?enrollment_term_id=42&per_page=100` +
      `&state%5B%5D=created&state%5B%5D=claimed&state%5B%5D=available&state%5B%5D=completed&include%5B%5D=term`;
    const mock = mockFetch([
      { url, response: () => rawResponse("[]") },
    ]);
    const result = await listAccountCoursesForTerm(BASE, TOKEN, "42", {
      fetchImpl: mock.fetchImpl,
      accountId: "9999",
    });
    expect(result).toEqual([]);
  });

  it("URL-encodes the term id (defends against the picker shipping a name)", async () => {
    // URLSearchParams encodes spaces as `+` (form-style); Canvas accepts
    // both. The defensive assertion is "the input never reaches the URL
    // raw" — a space in the path/query would be a malformed request.
    const mock = mockFetch([
      {
        url: (u) =>
          u.startsWith(
            `${BASE}/api/v1/accounts/self/courses?enrollment_term_id=2026+Spring`,
          ),
        response: () => rawResponse("[]"),
      },
    ]);
    await listAccountCoursesForTerm(BASE, TOKEN, "2026 Spring", {
      fetchImpl: mock.fetchImpl,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).not.toContain("2026 Spring");
  });

  it("propagates 401 as CanvasApiError unauthorized so the provider can fall back", async () => {
    const mock = mockFetch([
      {
        url: (u) => u.startsWith(`${BASE}/api/v1/accounts/self/courses?`),
        response: () =>
          jsonResponse({ errors: ["unauthorized"] }, { status: 401 }),
      },
    ]);
    await expect(
      listAccountCoursesForTerm(BASE, TOKEN, "101", {
        fetchImpl: mock.fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "CanvasApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listEnrollments", () => {
  it("returns mapped student/teacher/TA rows and skips observers", async () => {
    const mock = mockFetch([
      {
        url: (u) =>
          u.startsWith(`${BASE}/api/v1/courses/5001/enrollments?`),
        response: () => rawResponse(loadFixture("enrollments.json")),
      },
    ]);
    const result = await listEnrollments(BASE, TOKEN, "5001", {
      fetchImpl: mock.fetchImpl,
    });

    expect(result).toHaveLength(4); // observer dropped
    expect(result.map((e) => `${e.role}:${e.external_user_id}`)).toEqual([
      "student:7001",
      "student:7002",
      "teacher:7100",
      "teacher_assistant:7150",
    ]);

    // Bob has no email but a login_id that looks like an email — fall back.
    const bob = result.find((e) => e.external_user_id === "7002");
    expect(bob?.email).toBe("bob@students.example.edu");

    // Alice has both email and login_id — email wins.
    const alice = result.find((e) => e.external_user_id === "7001");
    expect(alice?.email).toBe("alice@students.example.edu");
    expect(alice?.external_id).toBe("90001");
    expect(alice?.external_course_id).toBe("5001");
  });

  it("surfaces 401 as CanvasApiError unauthorized", async () => {
    const mock = mockFetch([
      {
        url: (u) =>
          u.startsWith(`${BASE}/api/v1/courses/5001/enrollments?`),
        response: () => jsonResponse({}, { status: 401 }),
      },
    ]);
    await expect(
      listEnrollments(BASE, TOKEN, "5001", { fetchImpl: mock.fetchImpl }),
    ).rejects.toBeInstanceOf(CanvasApiError);
  });

  it("encodes courseId for path safety", async () => {
    const weirdId = "1234/abc";
    const mock = mockFetch([
      {
        url: (u) =>
          u.startsWith(
            `${BASE}/api/v1/courses/${encodeURIComponent(weirdId)}/enrollments?`,
          ),
        response: () => rawResponse("[]"),
      },
    ]);
    await listEnrollments(BASE, TOKEN, weirdId, { fetchImpl: mock.fetchImpl });
    expect(mock.calls).toHaveLength(1);
  });
});

describe("listManageableAccounts", () => {
  it("returns mapped accounts (id, name, parent_account_id) from /api/v1/accounts", async () => {
    const url = `${BASE}/api/v1/accounts?per_page=100`;
    const mock = mockFetch([
      {
        url,
        response: () => rawResponse(loadFixture("accounts.json")),
      },
    ]);
    const result = await listManageableAccounts(BASE, TOKEN, {
      fetchImpl: mock.fetchImpl,
    });
    expect(result).toEqual([
      { id: "1", name: "Frostburg State University", parent_account_id: null },
      {
        id: "42",
        name: "FSU — College of Engineering",
        parent_account_id: "1",
      },
    ]);

    const headers = new Headers(mock.calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("returns [] when Canvas reports no manageable accounts (regular instructor)", async () => {
    const mock = mockFetch([
      {
        url: `${BASE}/api/v1/accounts?per_page=100`,
        response: () => rawResponse("[]"),
      },
    ]);
    const result = await listManageableAccounts(BASE, TOKEN, {
      fetchImpl: mock.fetchImpl,
    });
    expect(result).toEqual([]);
  });

  it("propagates 401 as CanvasApiError unauthorized", async () => {
    const mock = mockFetch([
      {
        url: `${BASE}/api/v1/accounts?per_page=100`,
        response: () => jsonResponse({ errors: ["unauth"] }, { status: 401 }),
      },
    ]);
    await expect(
      listManageableAccounts(BASE, TOKEN, { fetchImpl: mock.fetchImpl }),
    ).rejects.toMatchObject({
      name: "CanvasApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("deriveTermsFromCourses", () => {
  const TEACHER_URL =
    `${BASE}/api/v1/courses?enrollment_state=active&enrollment_type=teacher` +
    `&per_page=100&include%5B%5D=term`;
  const TA_URL =
    `${BASE}/api/v1/courses?enrollment_state=active&enrollment_type=ta` +
    `&per_page=100&include%5B%5D=term`;

  it("dedupes embedded term info across the user's teacher + ta courses", async () => {
    const mock = mockFetch([
      {
        url: TEACHER_URL,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
      { url: TA_URL, response: () => rawResponse("[]") },
    ]);
    const result = await deriveTermsFromCourses(BASE, TOKEN, {
      fetchImpl: mock.fetchImpl,
    });
    // page1 has two courses both in term 101 → one row.
    expect(result).toEqual([
      {
        external_id: "101",
        name: "Fall 2025",
        start_date: "2025-08-25T00:00:00Z",
        end_date: "2025-12-15T00:00:00Z",
      },
    ]);
  });
});
