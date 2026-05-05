// Canvas OAuth 2.0 helpers (sub-issue UNI-52).
//
// Canvas implements the standard Authorization Code grant. The endpoints
// are:
//
//   GET  <base_url>/login/oauth2/auth   — authorize redirect target
//   POST <base_url>/login/oauth2/token  — code exchange + refresh
//
// Reference: https://canvas.instructure.com/doc/api/file.oauth.html
//
// Notes that drive choices below:
//
//   * Canvas does NOT rotate the refresh token on a refresh exchange — a
//     refresh response carries a fresh `access_token` + `expires_in` only.
//     We surface this by leaving `refresh_token` as `null` on
//     `refreshAccessToken` results; the caller keeps the previous value.
//
//   * The `expires_in` field is seconds-from-now. We convert to an
//     absolute ISO-8601 timestamp here so callers can store it directly
//     in `lms_connections.token_expires_at` without re-computing.
//
//   * The token endpoint returns `scope` only on the initial authorize
//     exchange (sometimes), not on refresh. We thread the value through
//     when present and leave `null` otherwise.
//
//   * All OAuth POSTs are `application/x-www-form-urlencoded` — Canvas
//     rejects JSON bodies on the token endpoint.
//
// This module is fetch-injectable for testing; production callers pass
// the global `fetch`. No external deps.

import type { LmsProviderConfig } from "@university-hub/shared";

import { CanvasOAuthError, type FetchLike, USER_AGENT } from "./http.js";

/** Trim a trailing "/" off a base URL so concatenation produces clean
 *  paths. Canvas customers sometimes paste their tenant URL with a
 *  trailing slash; we normalize defensively. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Build the Canvas authorize URL. Returned to the browser as a redirect
 * by the connect-flow endpoint (sub-issue UNI-54). The `state` value is
 * minted server-side and stored alongside the user's pending OAuth row;
 * the callback handler verifies it before honoring the `code`.
 *
 * Canvas requires `client_id`, `response_type=code`, `redirect_uri`, and
 * `state`. `scope` is space-separated; an empty/unspecified scope grants
 * the developer-key default. `purpose` is a free-text label Canvas shows
 * the user on the consent screen.
 */
export function buildAuthorizeUrl(
  providerConfig: Pick<LmsProviderConfig, "base_url" | "client_id">,
  state: string,
  redirectUri: string,
  options: { scopes?: readonly string[]; purpose?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("client_id", providerConfig.client_id);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("state", state);
  if (options.scopes && options.scopes.length > 0) {
    params.set("scope", options.scopes.join(" "));
  }
  if (options.purpose && options.purpose.length > 0) {
    params.set("purpose", options.purpose);
  }
  return `${trimBaseUrl(providerConfig.base_url)}/login/oauth2/auth?${params.toString()}`;
}

/** Result of a successful token exchange (initial code grant). */
export interface CanvasTokenExchangeResult {
  access_token: string;
  refresh_token: string | null;
  /** Absolute ISO-8601 timestamp; null if Canvas omitted `expires_in`. */
  expires_at: string | null;
  /** Space-separated granted scopes; null if Canvas didn't return one. */
  scope: string | null;
}

/** Result of a refresh exchange. Canvas does not rotate the refresh
 *  token, so callers should retain their existing value. */
export interface CanvasTokenRefreshResult {
  access_token: string;
  expires_at: string | null;
  scope: string | null;
}

interface CanvasTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function expiresInToIso(
  expiresIn: unknown,
  now: () => Date,
): string | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    return null;
  }
  return new Date(now().getTime() + expiresIn * 1000).toISOString();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function postTokenForm(
  baseUrl: string,
  body: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<CanvasTokenResponse> {
  const url = `${trimBaseUrl(baseUrl)}/login/oauth2/token`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new CanvasOAuthError(
      "network_error",
      `Canvas token request failed: ${cause instanceof Error ? cause.message : "unknown"}`,
      { cause },
    );
  }

  let parsed: CanvasTokenResponse;
  try {
    parsed = (await response.json()) as CanvasTokenResponse;
  } catch {
    throw new CanvasOAuthError(
      "malformed_response",
      `Canvas token response was not valid JSON (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    const code = readString(parsed.error) ?? `http_${response.status}`;
    const detail = readString(parsed.error_description) ?? code;
    throw new CanvasOAuthError(code, `Canvas token endpoint error: ${detail}`);
  }
  return parsed;
}

/**
 * Exchange an authorization code for an access + refresh token pair.
 * Throws `CanvasOAuthError` on any failure path (network, non-2xx,
 * malformed JSON, missing access_token).
 */
export async function exchangeCodeForTokens(
  providerConfig: Pick<
    LmsProviderConfig,
    "base_url" | "client_id" | "client_secret"
  >,
  code: string,
  redirectUri: string,
  options: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<CanvasTokenExchangeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", providerConfig.client_id);
  body.set("client_secret", providerConfig.client_secret);
  body.set("redirect_uri", redirectUri);
  body.set("code", code);

  const parsed = await postTokenForm(providerConfig.base_url, body, fetchImpl);
  const accessToken = readString(parsed.access_token);
  if (!accessToken) {
    throw new CanvasOAuthError(
      "malformed_response",
      "Canvas token response missing access_token.",
    );
  }
  return {
    access_token: accessToken,
    refresh_token: readString(parsed.refresh_token),
    expires_at: expiresInToIso(parsed.expires_in, now),
    scope: readString(parsed.scope),
  };
}

/**
 * Trade a refresh token for a fresh access token. Canvas does not rotate
 * the refresh token in this flow — callers should keep their existing
 * `refresh_token` and only update `access_token` + `expires_at`.
 */
export async function refreshAccessToken(
  providerConfig: Pick<
    LmsProviderConfig,
    "base_url" | "client_id" | "client_secret"
  >,
  refreshToken: string,
  options: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<CanvasTokenRefreshResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", providerConfig.client_id);
  body.set("client_secret", providerConfig.client_secret);
  body.set("refresh_token", refreshToken);

  const parsed = await postTokenForm(providerConfig.base_url, body, fetchImpl);
  const accessToken = readString(parsed.access_token);
  if (!accessToken) {
    throw new CanvasOAuthError(
      "malformed_response",
      "Canvas refresh response missing access_token.",
    );
  }
  return {
    access_token: accessToken,
    expires_at: expiresInToIso(parsed.expires_in, now),
    scope: readString(parsed.scope),
  };
}
