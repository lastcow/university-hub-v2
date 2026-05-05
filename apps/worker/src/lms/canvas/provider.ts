// Canvas LMS provider (sub-issue UNI-52).
//
// Implements the `LmsProvider` interface from sub-issue UNI-51 by
// composing the helpers in `oauth.ts` and `api.ts`. The class is
// stateless apart from constructor-injected dependencies:
//
//   * `fetchImpl`    — defaults to the global `fetch`. Tests pass a
//                      vitest mock; the production singleton uses the
//                      Worker-bound default.
//
//   * `loadProviderConfig` — async lookup from `(university_id) →
//                      LmsProviderConfig`. Required by `refreshToken`
//                      because Canvas's refresh exchange needs the
//                      OAuth client_id + client_secret, which are NOT
//                      carried on the `LmsConnection` row. The default
//                      module-level singleton ships without this loader
//                      configured; route handlers that need refresh
//                      construct a request-scoped `CanvasProvider`
//                      bound to a DB-backed loader, OR call
//                      `refreshAccessToken` from `oauth.ts` directly
//                      (sub-issue UNI-54 / UNI-55).
//
// `authenticate` returns a *partial* `LmsConnection` — every field that
// derives from the OAuth response is populated, but `id`, `user_id`,
// and `university_id` are left as the empty string for the connect-flow
// caller (UNI-54) to fill in once it has minted the row id and resolved
// the user. Returning a fully-shaped object satisfies the interface
// without forcing the provider to invent identifiers it has no business
// owning.
//
// On a 401 from any list call, callers retry once via `refreshToken`
// before surfacing the failure (provider-level retry is intentionally
// omitted here; ownership of the retry policy belongs with the caller
// per the substrate's `refreshToken` doc comment).

import type {
  IsoDateString,
  LmsAuthCredentials,
  LmsConnection,
  LmsCourse,
  LmsEnrollment,
  LmsProviderConfig,
  LmsProviderId,
  LmsTerm,
} from "@university-hub/shared";

import type { LmsProvider } from "../provider.js";
import { lmsProviderRegistry } from "../registry.js";

import {
  deriveTermsFromCourses,
  listEnrollments as canvasListEnrollments,
  listMyCourses as canvasListMyCourses,
  listTerms as canvasListTerms,
} from "./api.js";
import { CanvasApiError, type FetchLike } from "./http.js";
import {
  exchangeCodeForTokens,
  refreshAccessToken,
} from "./oauth.js";

export interface CanvasProviderDeps {
  /** Test seam for `fetch`. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /**
   * Resolves the `LmsProviderConfig` for a given university — used by
   * `refreshToken` to pull the OAuth client credentials. Optional on
   * the default singleton (which throws a clear error if `refreshToken`
   * is called without one wired); request-scoped instances built by
   * route handlers should always supply one.
   */
  loadProviderConfig?: (
    universityId: string,
  ) => Promise<LmsProviderConfig>;
  /** Test seam for `Date.now`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

const EMPTY_ID = "" as const;

export class CanvasProvider implements LmsProvider {
  readonly id: LmsProviderId = "canvas";
  private readonly deps: CanvasProviderDeps;

  constructor(deps: CanvasProviderDeps = {}) {
    this.deps = deps;
  }

  async authenticate(
    creds: LmsAuthCredentials,
    providerConfig: LmsProviderConfig,
  ): Promise<LmsConnection> {
    const nowIso = (this.deps.now?.() ?? new Date()).toISOString() as IsoDateString;

    // PAT branch (UNI-51 PR #72 pulled this into Phase 1). When the user
    // pastes a Canvas Personal Access Token from Account → Settings →
    // New Access Token, we skip the OAuth dance entirely: the PAT IS
    // the access token, there is no refresh path, and `auth_method`
    // distinguishes the row at storage time so reconciliation /
    // refresh-decision code knows not to attempt rotation.
    if (creds.personal_access_token) {
      return {
        id: EMPTY_ID,
        user_id: EMPTY_ID,
        university_id: providerConfig.university_id,
        provider_id: "canvas",
        auth_method: "pat",
        base_url: providerConfig.base_url,
        access_token: creds.personal_access_token,
        refresh_token: null,
        token_expires_at: null,
        scope: null,
        status: "active",
        last_synced_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
    }

    if (!creds.code || !creds.redirect_uri) {
      throw new Error(
        "CanvasProvider.authenticate requires either `personal_access_token` or both `code` and `redirect_uri`.",
      );
    }
    const tokens = await exchangeCodeForTokens(
      providerConfig,
      creds.code,
      creds.redirect_uri,
      { fetchImpl: this.deps.fetchImpl, now: this.deps.now },
    );
    return {
      id: EMPTY_ID,
      user_id: EMPTY_ID,
      university_id: providerConfig.university_id,
      provider_id: "canvas",
      auth_method: "oauth",
      base_url: providerConfig.base_url,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: (tokens.expires_at as IsoDateString | null) ?? null,
      scope: tokens.scope,
      status: "active",
      last_synced_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
  }

  async refreshToken(connection: LmsConnection): Promise<LmsConnection> {
    if (connection.auth_method === "pat") {
      throw new Error(
        "CanvasProvider.refreshToken called on a PAT connection; PATs do not refresh — the user must re-paste a fresh token via /app/integrations.",
      );
    }
    if (!connection.refresh_token) {
      throw new Error(
        "CanvasProvider.refreshToken called on a connection without a refresh_token; reconnect is required.",
      );
    }
    if (!this.deps.loadProviderConfig) {
      throw new Error(
        "CanvasProvider.refreshToken requires a `loadProviderConfig` dep — construct a request-scoped CanvasProvider with one, or call refreshAccessToken() from canvas/oauth.ts directly.",
      );
    }
    const providerConfig = await this.deps.loadProviderConfig(
      connection.university_id,
    );
    const refreshed = await refreshAccessToken(
      providerConfig,
      connection.refresh_token,
      { fetchImpl: this.deps.fetchImpl, now: this.deps.now },
    );
    const nowIso = (this.deps.now?.() ?? new Date()).toISOString() as IsoDateString;
    return {
      ...connection,
      access_token: refreshed.access_token,
      // Canvas does not rotate the refresh token on this exchange.
      refresh_token: connection.refresh_token,
      token_expires_at:
        (refreshed.expires_at as IsoDateString | null) ??
        connection.token_expires_at,
      scope: refreshed.scope ?? connection.scope,
      status: "active",
      updated_at: nowIso,
    };
  }

  async listTerms(connection: LmsConnection): Promise<LmsTerm[]> {
    try {
      return await canvasListTerms(connection.base_url, connection.access_token, {
        fetchImpl: this.deps.fetchImpl,
      });
    } catch (err) {
      // Regular instructors typically can't list terms via the
      // accounts endpoint; fall back to deriving the term set from
      // their courses. We treat both 401 and 403 as "no admin scope".
      if (
        err instanceof CanvasApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        return deriveTermsFromCourses(
          connection.base_url,
          connection.access_token,
          { fetchImpl: this.deps.fetchImpl },
        );
      }
      throw err;
    }
  }

  listMyCourses(
    connection: LmsConnection,
    termId: string,
  ): Promise<LmsCourse[]> {
    return canvasListMyCourses(
      connection.base_url,
      connection.access_token,
      termId,
      { fetchImpl: this.deps.fetchImpl },
    );
  }

  listEnrollments(
    connection: LmsConnection,
    courseId: string,
  ): Promise<LmsEnrollment[]> {
    return canvasListEnrollments(
      connection.base_url,
      connection.access_token,
      courseId,
      { fetchImpl: this.deps.fetchImpl },
    );
  }
}

/**
 * Side-effect: register the default Canvas provider on the process-wide
 * registry. Importing `apps/worker/src/lms/canvas` (which re-exports
 * this module) is enough to wire Canvas in. Tests that want isolation
 * use `new CanvasProvider({ ... })` against a fresh
 * `new LmsProviderRegistry()`.
 *
 * The default instance has no `loadProviderConfig` — `refreshToken`
 * raises a clear error until a route handler swaps in a request-scoped
 * instance. This keeps module import side-effects free of any DB / env
 * coupling.
 */
export const defaultCanvasProvider = new CanvasProvider();
lmsProviderRegistry.register(defaultCanvasProvider);
