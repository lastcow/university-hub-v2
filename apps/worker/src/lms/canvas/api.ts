// Canvas REST v1 client (sub-issue UNI-52).
//
// Thin, typed wrapper around the three endpoints Phase 1 needs:
//
//   * GET /api/v1/accounts/{account_id}/terms      → LmsTerm[]
//   * GET /api/v1/courses (current user, scoped)   → LmsCourse[]
//   * GET /api/v1/courses/{id}/enrollments         → LmsEnrollment[]
//
// All three are paginated by Canvas via the `Link` response header
// (RFC 5988); we follow `rel="next"` until exhausted and accumulate
// rows. Pagination is implemented here (not deferred to Phase 2) per the
// issue body: "respect Canvas's pagination Link headers (full pagination
// handling can land here or in Phase 2 sub-issue, prefer here for
// completeness)."
//
// All requests send:
//   * `Authorization: Bearer <access_token>`
//   * `User-Agent: UniversityHub/1.0`
//   * `Accept: application/json`
//
// Error handling (the layered classifier `CanvasApiError`):
//   * Network failure   → status=0, code='network_error'
//   * HTTP 401          → status=401, code='unauthorized' — caller
//     refreshes the access token and retries (provider.ts owns the
//     once-only retry).
//   * HTTP 429          → status=429, code='rate_limited' — caller
//     surfaces a sync error; backoff is Phase 2.
//   * Other non-2xx     → status=<code>, code='http_error' — caller
//     records a sync error.
//   * Malformed JSON    → status=<status>, code='malformed_response'.
//
// Decision: list-terms account scoping
// -----------------------------------
// The Canvas "List enrollment terms" endpoint is `/api/v1/accounts/
// {account_id}/terms`. Regular instructors typically lack admin scope on
// the root account, so we hit `/api/v1/accounts/self/terms` by default
// — Canvas resolves `self` to the calling user's account context. If
// that returns 401/403 (the user is not an admin of any account), the
// caller should fall back to deriving the term list from
// `listMyCourses` results' embedded `term` data. We expose the helper
// here as `deriveTermsFromCourses` so `provider.ts` can implement that
// fallback in one place.

import type {
  LmsCourse,
  LmsEnrollment,
  LmsTerm,
} from "@university-hub/shared";

import {
  CanvasApiError,
  type FetchLike,
  parseNextLink,
  trimBaseUrl,
  USER_AGENT,
} from "./http.js";

interface CanvasGetOptions {
  fetchImpl?: FetchLike;
}

/**
 * Probe `<base_url>/api/v1/users/self` with the supplied PAT. Used both
 * by the admin "validate-on-save" form (UNI-63 §4) and the user-facing
 * connect flow (UNI-63 §5) to confirm that the (base_url, PAT) pair
 * Canvas will accept before the connection row is written.
 *
 * Returns `{ ok: true, user_id, name? }` on a 200 response. Throws a
 * `CanvasApiError` on any failure path; the route handler maps
 * `status === 401` to the user-facing "invalid token" copy and
 * everything else to a generic upstream-error response.
 *
 * The PAT is passed as `Authorization: Bearer <token>` exactly like
 * every other Canvas REST call — `users/self` is the cheapest
 * authenticated endpoint and confirms BOTH that the URL is a Canvas
 * tenant AND that the PAT is valid for it.
 */
export async function validatePersonalAccessToken(
  baseUrl: string,
  personalAccessToken: string,
  options: CanvasGetOptions = {},
): Promise<{ external_user_id: string; name: string | null }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${trimBaseUrl(baseUrl)}/api/v1/users/self`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${personalAccessToken}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
  } catch (cause) {
    throw new CanvasApiError(
      0,
      "network_error",
      `Canvas request to ${url} failed: ${cause instanceof Error ? cause.message : "unknown"}`,
      { cause },
    );
  }

  if (response.status === 401) {
    throw new CanvasApiError(
      401,
      "unauthorized",
      "Canvas rejected the supplied access token (HTTP 401).",
    );
  }
  if (!response.ok) {
    throw new CanvasApiError(
      response.status,
      "http_error",
      `Canvas returned HTTP ${response.status} validating PAT.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CanvasApiError(
      response.status,
      "malformed_response",
      "Canvas /users/self response was not valid JSON.",
    );
  }
  const obj = isObject(body) ? body : {};
  const id = obj.id;
  if (id === undefined || id === null) {
    throw new CanvasApiError(
      response.status,
      "malformed_response",
      "Canvas /users/self response missing user id.",
    );
  }
  return {
    external_user_id: String(id),
    name: typeof obj.name === "string" ? obj.name : null,
  };
}

/**
 * Issue a paginated GET against Canvas, accumulating every page into a
 * single array. The `extract` callback turns each parsed JSON body into
 * an array of typed rows — Canvas is mostly consistent ("returns an
 * array of T") but the terms endpoint wraps in `{ enrollment_terms: [] }`,
 * so this hook keeps the loop generic.
 */
async function getAllPages<TRow>(
  initialUrl: string,
  accessToken: string,
  fetchImpl: FetchLike,
  extract: (body: unknown) => TRow[],
): Promise<TRow[]> {
  const out: TRow[] = [];
  let url: string | null = initialUrl;
  while (url) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      throw new CanvasApiError(
        0,
        "network_error",
        `Canvas request to ${url} failed: ${cause instanceof Error ? cause.message : "unknown"}`,
        { cause },
      );
    }

    if (response.status === 401) {
      throw new CanvasApiError(
        401,
        "unauthorized",
        "Canvas rejected the access token (HTTP 401).",
      );
    }
    if (response.status === 429) {
      throw new CanvasApiError(
        429,
        "rate_limited",
        "Canvas rate-limited the request (HTTP 429).",
      );
    }
    if (!response.ok) {
      throw new CanvasApiError(
        response.status,
        "http_error",
        `Canvas returned HTTP ${response.status} for ${url}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CanvasApiError(
        response.status,
        "malformed_response",
        `Canvas response for ${url} was not valid JSON.`,
      );
    }

    out.push(...extract(body));
    url = parseNextLink(response.headers.get("Link"));
  }
  return out;
}

// ---------- Terms ----------

interface CanvasTerm {
  id?: number | string;
  name?: string;
  start_at?: string | null;
  end_at?: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function mapTerm(raw: CanvasTerm): LmsTerm | null {
  if (raw.id === undefined || raw.id === null) return null;
  return {
    external_id: String(raw.id),
    name: typeof raw.name === "string" ? raw.name : String(raw.id),
    start_date: typeof raw.start_at === "string" ? raw.start_at : null,
    end_date: typeof raw.end_at === "string" ? raw.end_at : null,
  };
}

/**
 * GET `/api/v1/accounts/{accountId}/terms`. Defaults to `accountId='self'`
 * which Canvas resolves against the calling user. Returns rows in the
 * order Canvas emits them (Canvas does not document the order; treat as
 * unsorted and sort downstream if a stable UI ordering is needed).
 *
 * The endpoint wraps the array in `{ enrollment_terms: [...] }`.
 */
export async function listTerms(
  baseUrl: string,
  accessToken: string,
  options: CanvasGetOptions & { accountId?: string } = {},
): Promise<LmsTerm[]> {
  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const accountId = options.accountId ?? "self";
  const url = `${trimBaseUrl(baseUrl)}/api/v1/accounts/${encodeURIComponent(accountId)}/terms?per_page=100`;
  return getAllPages<LmsTerm>(url, accessToken, fetchImpl, (body) => {
    const list = isObject(body) && Array.isArray(body.enrollment_terms)
      ? (body.enrollment_terms as CanvasTerm[])
      : [];
    return list
      .map(mapTerm)
      .filter((t): t is LmsTerm => t !== null);
  });
}

// ---------- Courses ----------

interface CanvasCourseTerm {
  id?: number | string;
  name?: string;
  start_at?: string | null;
  end_at?: string | null;
}

interface CanvasCourse {
  id?: number | string;
  name?: string;
  course_code?: string | null;
  public_description?: string | null;
  enrollment_term_id?: number | string | null;
  term?: CanvasCourseTerm;
  workflow_state?: string;
}

function mapCourse(raw: CanvasCourse): LmsCourse | null {
  if (raw.id === undefined || raw.id === null) return null;
  const externalTermId =
    raw.enrollment_term_id !== undefined && raw.enrollment_term_id !== null
      ? String(raw.enrollment_term_id)
      : isObject(raw.term) && raw.term.id !== undefined && raw.term.id !== null
        ? String(raw.term.id)
        : null;
  return {
    external_id: String(raw.id),
    external_term_id: externalTermId,
    name: typeof raw.name === "string" ? raw.name : String(raw.id),
    code:
      typeof raw.course_code === "string" && raw.course_code.length > 0
        ? raw.course_code
        : null,
    description:
      typeof raw.public_description === "string" &&
      raw.public_description.length > 0
        ? raw.public_description
        : null,
  };
}

/**
 * GET `/api/v1/courses` for the current user. We pull active courses
 * across the user's teaching enrollments (TeacherEnrollment + TaEnrollment)
 * and filter client-side to the requested term — Canvas does expose an
 * `enrollment_term_id` filter on the endpoint, but only with admin scope,
 * so the client-side filter keeps this working for ordinary instructors.
 *
 * The Canvas response includes `term` only when `include[]=term` is set;
 * we always request it so the term-derivation fallback in
 * `deriveTermsFromCourses` has data to work with.
 *
 * Note: this is the *user-scoped* path. Canvas only returns courses the
 * acting user is enrolled in. For an account admin (no Teacher / TA
 * enrollment of their own) this returns 0 — `provider.listMyCourses`
 * tries `listAccountCoursesForTerm` first and only falls back here on
 * 401/403 (UNI-64).
 */
export async function listMyCourses(
  baseUrl: string,
  accessToken: string,
  termId: string,
  options: CanvasGetOptions = {},
): Promise<LmsCourse[]> {
  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  params.set("enrollment_state", "active");
  params.set("per_page", "100");
  params.append("enrollment_role[]", "TeacherEnrollment");
  params.append("enrollment_role[]", "TaEnrollment");
  params.append("include[]", "term");
  const url = `${trimBaseUrl(baseUrl)}/api/v1/courses?${params.toString()}`;
  const all = await getAllPages<LmsCourse>(
    url,
    accessToken,
    fetchImpl,
    (body) => {
      const list = Array.isArray(body) ? (body as CanvasCourse[]) : [];
      return list
        .map(mapCourse)
        .filter((c): c is LmsCourse => c !== null);
    },
  );
  return all.filter((c) => c.external_term_id === termId);
}

/**
 * GET `/api/v1/accounts/{accountId}/courses?enrollment_term_id=...`.
 * The *account-scoped* course list — returns every course in the
 * account for the given term, regardless of whether the calling user
 * is enrolled in them. Requires admin scope on the token; the caller
 * (`provider.listMyCourses`) treats 401/403 as "no admin scope" and
 * falls back to the user-scoped path.
 *
 * `state[]` is set explicitly to include unpublished and completed
 * courses too — without it Canvas would silently drop courses still
 * in draft, which is the same symptom as the bug we're fixing
 * (UNI-64 root cause #4).
 *
 * `include[]=term` mirrors `listMyCourses` so the embedded term info
 * is available to downstream callers if they ever need it.
 */
export async function listAccountCoursesForTerm(
  baseUrl: string,
  accessToken: string,
  termId: string,
  options: CanvasGetOptions & { accountId?: string } = {},
): Promise<LmsCourse[]> {
  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const accountId = options.accountId ?? "self";
  const params = new URLSearchParams();
  params.set("enrollment_term_id", termId);
  params.set("per_page", "100");
  params.append("state[]", "created");
  params.append("state[]", "claimed");
  params.append("state[]", "available");
  params.append("state[]", "completed");
  params.append("include[]", "term");
  const url = `${trimBaseUrl(baseUrl)}/api/v1/accounts/${encodeURIComponent(accountId)}/courses?${params.toString()}`;
  return getAllPages<LmsCourse>(url, accessToken, fetchImpl, (body) => {
    const list = Array.isArray(body) ? (body as CanvasCourse[]) : [];
    return list
      .map(mapCourse)
      .filter((c): c is LmsCourse => c !== null);
  });
}

/** Build an `LmsTerm[]` by deduping the embedded term info on the
 *  user's courses. Used as a fallback when `listTerms` 401s because the
 *  user lacks account admin scope. Same shape contract as `listTerms`. */
export function deriveTermsFromCourses(
  baseUrl: string,
  accessToken: string,
  options: CanvasGetOptions = {},
): Promise<LmsTerm[]> {
  // We want every active course (across all terms), so we don't filter
  // by term here. Re-issues the same request as `listMyCourses` but
  // returns the raw `term` payloads.
  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  params.set("enrollment_state", "active");
  params.set("per_page", "100");
  params.append("enrollment_role[]", "TeacherEnrollment");
  params.append("enrollment_role[]", "TaEnrollment");
  params.append("include[]", "term");
  const url = `${trimBaseUrl(baseUrl)}/api/v1/courses?${params.toString()}`;
  return getAllPages<LmsTerm>(url, accessToken, fetchImpl, (body) => {
    const list = Array.isArray(body) ? (body as CanvasCourse[]) : [];
    const seen = new Map<string, LmsTerm>();
    for (const course of list) {
      const t = course.term;
      if (!isObject(t) || t.id === undefined || t.id === null) continue;
      const id = String(t.id);
      if (seen.has(id)) continue;
      seen.set(id, {
        external_id: id,
        name: typeof t.name === "string" ? t.name : id,
        start_date: typeof t.start_at === "string" ? t.start_at : null,
        end_date: typeof t.end_at === "string" ? t.end_at : null,
      });
    }
    return Array.from(seen.values());
  });
}

// ---------- Enrollments ----------

interface CanvasEnrollmentUser {
  id?: number | string;
  name?: string;
  email?: string | null;
  login_id?: string | null;
}

interface CanvasEnrollment {
  id?: number | string;
  user_id?: number | string;
  course_id?: number | string;
  type?: string;
  role?: string;
  user?: CanvasEnrollmentUser;
}

const CANVAS_TYPE_TO_ROLE: Record<string, LmsEnrollment["role"]> = {
  StudentEnrollment: "student",
  TeacherEnrollment: "teacher",
  TaEnrollment: "teacher_assistant",
  // DesignerEnrollment / ObserverEnrollment fall through (skipped).
};

function mapEnrollment(raw: CanvasEnrollment): LmsEnrollment | null {
  if (raw.user_id === undefined || raw.user_id === null) return null;
  if (raw.course_id === undefined || raw.course_id === null) return null;
  if (typeof raw.type !== "string") return null;
  const role = CANVAS_TYPE_TO_ROLE[raw.type];
  if (!role) return null;
  const user = isObject(raw.user) ? raw.user : {};
  const email =
    typeof user.email === "string" && user.email.length > 0
      ? user.email
      : typeof user.login_id === "string" &&
          user.login_id.length > 0 &&
          user.login_id.includes("@")
        ? user.login_id
        : null;
  return {
    external_id:
      raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    external_course_id: String(raw.course_id),
    external_user_id: String(raw.user_id),
    email,
    name: typeof user.name === "string" ? user.name : null,
    role,
  };
}

/**
 * GET `/api/v1/courses/{courseId}/enrollments`. We request student,
 * teacher, and TA enrollments — observers and designers are filtered
 * out (they don't map onto Hub's `course_assignments.role` set).
 *
 * `include[]=user` ensures the response carries name/email; without it
 * Canvas only returns ids and the reconciliation engine has nothing to
 * match against.
 */
export async function listEnrollments(
  baseUrl: string,
  accessToken: string,
  courseId: string,
  options: CanvasGetOptions = {},
): Promise<LmsEnrollment[]> {
  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  params.set("per_page", "100");
  params.append("type[]", "StudentEnrollment");
  params.append("type[]", "TeacherEnrollment");
  params.append("type[]", "TaEnrollment");
  params.append("include[]", "user");
  params.append("include[]", "email");
  const url = `${trimBaseUrl(baseUrl)}/api/v1/courses/${encodeURIComponent(courseId)}/enrollments?${params.toString()}`;
  return getAllPages<LmsEnrollment>(
    url,
    accessToken,
    fetchImpl,
    (body) => {
      const list = Array.isArray(body) ? (body as CanvasEnrollment[]) : [];
      return list
        .map(mapEnrollment)
        .filter((e): e is LmsEnrollment => e !== null);
    },
  );
}
