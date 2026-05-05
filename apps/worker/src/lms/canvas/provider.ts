// Canvas LMS provider (sub-issue UNI-52; reshaped in UNI-63 to drop
// the OAuth dance entirely — the user supplies a Personal Access Token
// from Canvas's Account → Settings → "+ New Access Token" page).
//
// Implements the `LmsProvider` interface from sub-issue UNI-51 by
// composing the helpers in `api.ts`. The class is stateless apart
// from constructor-injected dependencies:
//
//   * `fetchImpl`    — defaults to the global `fetch`. Tests pass a
//                      vitest mock; the production singleton uses the
//                      Worker-bound default.
//
//   * `now`          — defaults to `() => new Date()`. Test seam.
//
// `authenticate` validates the PAT against `<base_url>/api/v1/users/self`
// and returns a partial `LmsConnection` — every field that derives from
// the validation response is populated, but `id`, `user_id`, and
// `university_id` are left as the empty string for the connect-flow
// caller (the route handler in `routes/lms-connections.ts`) to fill in
// once it has minted the row id and resolved the user.

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
  listAccountCoursesForTerm as canvasListAccountCoursesForTerm,
  listEnrollments as canvasListEnrollments,
  listMyCourses as canvasListMyCourses,
  listTerms as canvasListTerms,
  validatePersonalAccessToken,
} from "./api.js";
import { CanvasApiError, type FetchLike } from "./http.js";

export interface CanvasProviderDeps {
  /** Test seam for `fetch`. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
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
    if (!creds.personal_access_token) {
      throw new Error(
        "CanvasProvider.authenticate requires `personal_access_token`.",
      );
    }
    // Validate the PAT against `/api/v1/users/self` before returning a
    // success shape — a 401 throws so the caller (route handler) can
    // surface "invalid token" without ever writing a row.
    await validatePersonalAccessToken(
      providerConfig.base_url,
      creds.personal_access_token,
      { fetchImpl: this.deps.fetchImpl },
    );

    const nowIso = (this.deps.now?.() ?? new Date()).toISOString() as IsoDateString;
    return {
      id: EMPTY_ID,
      user_id: EMPTY_ID,
      university_id: providerConfig.university_id,
      provider_id: "canvas",
      base_url: providerConfig.base_url,
      access_token: creds.personal_access_token,
      status: "active",
      last_synced_at: null,
      created_at: nowIso,
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

  async listMyCourses(
    connection: LmsConnection,
    termId: string,
  ): Promise<LmsCourse[]> {
    // Prefer the account-scoped endpoint so account admins (who have
    // no Teacher / TA enrollment of their own) still get the full
    // course list for the term. Regular instructors lack admin scope
    // on `/accounts/:id/courses`, which Canvas surfaces as 401/403 —
    // we fall back to the user-scoped path for them, matching the
    // pre-UNI-64 behavior. Mirrors the same fallback shape as
    // `listTerms`.
    try {
      return await canvasListAccountCoursesForTerm(
        connection.base_url,
        connection.access_token,
        termId,
        { fetchImpl: this.deps.fetchImpl },
      );
    } catch (err) {
      if (
        err instanceof CanvasApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        return canvasListMyCourses(
          connection.base_url,
          connection.access_token,
          termId,
          { fetchImpl: this.deps.fetchImpl },
        );
      }
      throw err;
    }
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
 */
export const defaultCanvasProvider = new CanvasProvider();
lmsProviderRegistry.register(defaultCanvasProvider);
