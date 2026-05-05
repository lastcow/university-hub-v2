// Shared HTTP primitives for the Canvas adapter (sub-issue UNI-52).
//
// The two callers — `oauth.ts` (token endpoint) and `api.ts` (REST v1) —
// both need:
//   * a typed `FetchLike` boundary so tests can stub HTTP without
//     monkey-patching the global,
//   * a fixed User-Agent so Canvas operators can identify University Hub
//     traffic in their access logs (issue body: "All requests send
//     `User-Agent: UniversityHub/1.0`"),
//   * a small set of typed error classes that the provider layer maps
//     onto retry / refresh / surface-to-user decisions.

/**
 * The injectable fetch boundary. Mirrors the shape used in
 * `apps/worker/src/mail/mailgun.ts` so the worker can pass either the
 * global `fetch` or — under tests — a vitest-mocked function.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Sent on every Canvas request. */
export const USER_AGENT = "UniversityHub/1.0";

/** Thrown by `oauth.ts` for any token-endpoint failure (network, non-2xx,
 *  malformed body, missing access_token). The `code` field carries
 *  Canvas's `error` value verbatim when available, or a synthetic
 *  classifier (`network_error`, `malformed_response`, `http_<status>`)
 *  when not. */
export class CanvasOAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CanvasOAuthError";
    this.code = code;
  }
}

/** Thrown by `api.ts` for any REST-call failure. `status` is the HTTP
 *  status code (or `0` for network-layer failures). The provider layer
 *  treats `status === 401` as the "refresh and retry" trigger and
 *  `status === 429` as the "rate-limited" classifier; everything else
 *  bubbles to the route handler as a hard sync-error row. */
export class CanvasApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    status: number,
    code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CanvasApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Parse a Canvas `Link` response header and return the URL with
 * `rel="next"` if one is present. Canvas paginates every list endpoint
 * and signals further pages via this header (matching RFC 5988); when
 * the header is absent or has no `rel="next"` entry, the caller has
 * received the last page.
 *
 * The header value looks like:
 *   <https://x.instructure.com/api/v1/...&page=bookmark:abc>; rel="current",
 *   <https://x.instructure.com/api/v1/...&page=bookmark:def>; rel="next",
 *   <https://x.instructure.com/api/v1/...&page=first>; rel="first"
 *
 * We split on commas, then on `; `, and accept either `rel=next` or
 * `rel="next"` per the RFC's permissive quoting.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(",")) {
    const parts = segment.split(";").map((s) => s.trim());
    const urlPart = parts[0];
    if (!urlPart || !urlPart.startsWith("<") || !urlPart.endsWith(">")) {
      continue;
    }
    const isNext = parts
      .slice(1)
      .some(
        (p) =>
          p === 'rel="next"' || p === "rel=next" || p === "rel='next'",
      );
    if (isNext) {
      return urlPart.slice(1, -1);
    }
  }
  return null;
}
