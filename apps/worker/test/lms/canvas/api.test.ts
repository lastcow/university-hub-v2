// Canvas REST client tests (sub-issue UNI-52). All HTTP via FetchLike
// mock; fixture JSON in ./fixtures/.

import { describe, expect, it } from "vitest";

import {
  deriveTermsFromCourses,
  listAccountCoursesForTerm,
  listEnrollments,
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
  it("paginates via the Link header and filters to the requested term", async () => {
    const url1 =
      `${BASE}/api/v1/courses?enrollment_state=active&per_page=100` +
      `&enrollment_role%5B%5D=TeacherEnrollment&enrollment_role%5B%5D=TaEnrollment&include%5B%5D=term`;
    const url2 = `${BASE}/api/v1/courses?page=bookmark%3Adef&per_page=100`;
    const mock = mockFetch([
      {
        url: url1,
        response: () =>
          rawResponse(loadFixture("courses-page1.json"), {
            linkHeader: `<${url2}>; rel="next"`,
          }),
      },
      {
        url: url2,
        response: () => rawResponse(loadFixture("courses-page2.json")),
      },
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
    expect(mock.calls).toHaveLength(2);
  });

  it("returns empty array when no courses match the requested term", async () => {
    const url1 =
      `${BASE}/api/v1/courses?enrollment_state=active&per_page=100` +
      `&enrollment_role%5B%5D=TeacherEnrollment&enrollment_role%5B%5D=TaEnrollment&include%5B%5D=term`;
    const mock = mockFetch([
      {
        url: url1,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
    ]);
    const result = await listMyCourses(BASE, TOKEN, "999", {
      fetchImpl: mock.fetchImpl,
    });
    expect(result).toEqual([]);
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

describe("deriveTermsFromCourses", () => {
  it("dedupes embedded term info across the user's courses", async () => {
    const url1 =
      `${BASE}/api/v1/courses?enrollment_state=active&per_page=100` +
      `&enrollment_role%5B%5D=TeacherEnrollment&enrollment_role%5B%5D=TaEnrollment&include%5B%5D=term`;
    const mock = mockFetch([
      {
        url: url1,
        response: () => rawResponse(loadFixture("courses-page1.json")),
      },
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
