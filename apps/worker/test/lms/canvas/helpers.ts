// Test helpers shared by the Canvas adapter unit tests (sub-issue UNI-52).
//
// `mockFetch` builds a `FetchLike` whose behavior is driven by an array
// of "if URL/method matches, return this Response" handlers. Each call
// pops the first matching handler so tests can assert exact request
// sequencing (page-1, page-2, etc.). Unmatched requests throw with a
// descriptive message so test failures are easy to diagnose.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { FetchLike } from "../../../src/lms/canvas/http.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

export function loadJsonFixture<T = unknown>(name: string): T {
  return JSON.parse(loadFixture(name)) as T;
}

export interface FetchHandler {
  /** Request method, defaults to "GET" if omitted. */
  method?: string;
  /** Either an exact URL string or a predicate. */
  url: string | ((url: string) => boolean);
  /** Builder for the response, called once when the handler matches. */
  response: () => Response;
  /** Captured by the helper so tests can assert what was sent. */
  capture?: { url?: string; init?: RequestInit };
}

export interface FetchMock {
  fetchImpl: FetchLike;
  /** All calls made, in order, with the resolved url + init. */
  calls: Array<{ url: string; init: RequestInit }>;
}

/** Build a fetch mock backed by a queue of handlers. Each handler fires
 *  at most once, in declaration order — this lets tests assert paginated
 *  request sequences without writing custom matchers. */
export function mockFetch(handlers: FetchHandler[]): FetchMock {
  const queue = handlers.slice();
  const calls: FetchMock["calls"] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const idx = queue.findIndex((h) => {
      const methodMatch =
        (h.method ?? "GET").toUpperCase() ===
        (init.method ?? "GET").toUpperCase();
      const urlMatch =
        typeof h.url === "string" ? h.url === url : h.url(url);
      return methodMatch && urlMatch;
    });
    if (idx === -1) {
      throw new Error(
        `mockFetch: unexpected ${init.method ?? "GET"} ${url} — no handler matched (remaining: ${queue
          .map((h) => `${h.method ?? "GET"} ${typeof h.url === "string" ? h.url : "<predicate>"}`)
          .join(", ")})`,
      );
    }
    const [handler] = queue.splice(idx, 1);
    if (handler) {
      handler.capture = { url, init };
    }
    return handler!.response();
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { linkHeader?: string } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (init.linkHeader) {
    headers.set("Link", init.linkHeader);
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

export function rawResponse(
  body: string,
  init: ResponseInit & { linkHeader?: string } = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.linkHeader) {
    headers.set("Link", init.linkHeader);
  }
  return new Response(body, { status: init.status ?? 200, headers });
}
