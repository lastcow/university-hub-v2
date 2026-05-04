import type { ApiError } from "@university-hub/shared";

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
    return undefined as T;
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

  delete<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
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
