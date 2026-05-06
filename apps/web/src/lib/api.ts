import type { ApiError } from "@university-hub/shared";

// ---------------------------------------------------------------------------
// Session token storage (UNI-70)
//
// In production the SPA on `*.pages.dev` calls the Worker on `*.workers.dev`
// — separate eTLD+1's, so every request is third-party. Privacy-strict
// browsers (Safari ITP, Firefox total cookie protection, Brave, Chrome
// with 3p cookies disabled) silently drop the cross-site session cookie,
// which used to leave users authenticated server-side but unauthenticated
// client-side ("Authentication required" on every protected page on first
// load post-MFA).
//
// The Worker now also surfaces the raw session token in the sign-in /
// MFA-verify response body. We persist it here and replay it on every
// request via `Authorization: Bearer <token>`. The cookie still ships
// from the Worker as defense in depth for browsers that allow it; the
// header is the source of truth for cross-site browsers.
//
// The token is XSS-equivalent in scope to the rest of the app's auth
// state, but not strictly worse: an attacker with script execution on
// the SPA can already make authenticated `fetch()` calls because the
// browser attaches the (HttpOnly) cookie automatically when present.
// localStorage moves the bearer surface from "implicit on every fetch"
// to "explicit, readable by JS"; CSP + dependency hygiene remain the
// real mitigations.
//
// SSR-safe (`typeof window` guard) so the import doesn't crash in tests
// or any future server-rendered surface.
// ---------------------------------------------------------------------------

const SESSION_TOKEN_STORAGE_KEY = "university_hub_session_token";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.localStorage;
    // Probe — Safari Private Browsing throws on .setItem when storage is
    // denied. Treat any exception as "no storage available" and degrade
    // to header-less requests (the cookie still works for browsers that
    // accept it; everyone else will surface as unauthenticated, which is
    // strictly better than crashing the SPA).
    const probe = "__university_hub_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export function getStoredSessionToken(): string | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const value = ls.getItem(SESSION_TOKEN_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage write failed (quota, disabled mid-session). Same fallback
    // posture as `safeLocalStorage`: degrade silently, don't crash.
  }
}

export function clearStoredSessionToken(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    // No-op — same fallback posture as the read path.
  }
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(error: ApiError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = "ApiClientError";
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  query?: Record<string, string | number | boolean | null | undefined>;
}

interface InternalRequestOptions extends ApiRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

// In production the SPA ships from Cloudflare Pages and the API lives on a
// different host (the Worker), so the API client prefixes every request with
// `VITE_API_BASE_URL`. In dev the var is unset and we fall back to relative
// `/api/...` paths, which the Vite dev server proxies to the local Worker
// (see vite.config.ts).
const DEFAULT_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";

function buildUrl(
  baseUrl: string,
  path: string,
  query?: ApiRequestOptions["query"],
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${trimmedBase}${normalizedPath}`;

  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function networkError(cause: unknown): ApiClientError {
  return new ApiClientError(
    {
      code: "network_error",
      message: "Could not reach the server. Check your connection and try again.",
      status: 0,
    },
    { cause },
  );
}

function genericError(status: number): ApiClientError {
  return new ApiClientError({
    code: "unexpected_error",
    message: "Something went wrong. Please try again.",
    status,
  });
}

async function parseError(response: Response): Promise<ApiClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return genericError(response.status);
  }

  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object"
  ) {
    const raw = payload.error as Partial<ApiError>;
    return new ApiClientError({
      code: typeof raw.code === "string" ? raw.code : "unexpected_error",
      message:
        typeof raw.message === "string"
          ? raw.message
          : "Something went wrong. Please try again.",
      status: response.status,
      ...(raw.details && typeof raw.details === "object"
        ? { details: raw.details as Record<string, unknown> }
        : {}),
    });
  }

  return genericError(response.status);
}

async function parseSuccess<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // A 2xx response with a non-JSON body almost always means the request
    // never reached the Worker — the most common cause is a Pages deploy
    // built without `VITE_API_BASE_URL`, which makes the SPA call relative
    // `/api/...` paths and Pages serves the SPA fallback (HTML) for them.
    // Surface this as a loud error rather than silently returning
    // `undefined`; callers (e.g. AuthContext) would otherwise mark the
    // user as authenticated with no user object and render a blank page.
    throw new ApiClientError({
      code: "non_json_response",
      message:
        "Unexpected non-JSON response from the API. The web app may be " +
        "pointing at the wrong origin (check VITE_API_BASE_URL).",
      status: response.status,
    });
  }

  const payload = (await response.json()) as { data?: T } | T;
  if (
    payload &&
    typeof payload === "object" &&
    "data" in (payload as Record<string, unknown>)
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  defaultHeaders?: HeadersInit;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: HeadersInit | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.defaultHeaders = options.defaultHeaders;
  }

  get<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE", body });
  }

  private async request<T>(
    path: string,
    options: InternalRequestOptions,
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const headers = new Headers(this.defaultHeaders);
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    headers.set("accept", "application/json");

    // UNI-70: attach the persisted session token as a Bearer credential.
    // This is the SPA's primary auth transport in production because the
    // cross-site session cookie is dropped by privacy-strict browsers.
    // We only set it when the caller did not already set its own
    // Authorization header (e.g. the bootstrap endpoint uses a one-shot
    // BOOTSTRAP_SECRET — leave caller-supplied values alone).
    if (!headers.has("authorization")) {
      const token = getStoredSessionToken();
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
    }

    const init: RequestInit = {
      method: options.method,
      credentials: "include",
      headers,
      signal: options.signal,
    };

    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      throw networkError(cause);
    }

    if (!response.ok) {
      throw await parseError(response);
    }

    return parseSuccess<T>(response);
  }
}

export const api = new ApiClient();
