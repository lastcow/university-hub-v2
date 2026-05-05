// LMS provider abstraction (epic UNI-50 / sub-issue UNI-51).
//
// Every concrete provider (Canvas first in UNI-52; Blackboard / Moodle /
// Google Classroom in Phase 3) implements this interface. The shape is
// deliberately runtime-agnostic — the methods take what they need as
// arguments and return Promises, with no Worker / DO / Node coupling —
// so the same provider files can serve the Worker pull path today and a
// Durable-Object-backed scheduled-sync path later (epic, locked
// decisions: "Provider abstraction is runtime-agnostic so the swap is
// feasible").
//
// The interface intentionally does NOT hold provider state. `connection`
// is passed in on every call; storage of the row is the worker's job.
// Refresh logic is exposed separately via `refreshToken` so the calling
// code can decide when to invoke it (typically when `token_expires_at`
// has elapsed) without each method silently mutating a row.

import type {
  LmsAuthCredentials,
  LmsConnection,
  LmsCourse,
  LmsEnrollment,
  LmsProviderConfig,
  LmsProviderId,
  LmsTerm,
} from "@university-hub/shared";

export interface LmsProvider {
  readonly id: LmsProviderId;

  /**
   * Exchange OAuth credentials (or a PAT) for an authenticated
   * connection. The returned `LmsConnection` carries plaintext tokens —
   * the caller is responsible for field-encrypting them before they
   * land in `lms_connections`.
   */
  authenticate(
    creds: LmsAuthCredentials,
    providerConfig: LmsProviderConfig,
  ): Promise<LmsConnection>;

  /**
   * Refresh an expiring connection in-place. Returns a new
   * `LmsConnection` carrying the rotated `access_token` and (where the
   * provider supports it) a fresh `refresh_token`. Callers that get a
   * 401 from the provider mid-call should retry once via this method
   * before surfacing the failure to the user.
   */
  refreshToken(connection: LmsConnection): Promise<LmsConnection>;

  /** Provider-native term catalog for the user's tenant. */
  listTerms(connection: LmsConnection): Promise<LmsTerm[]>;

  /** Courses the connected user has any role on, scoped to one term. */
  listMyCourses(
    connection: LmsConnection,
    termId: string,
  ): Promise<LmsCourse[]>;

  /** Enrolled members of a single course. */
  listEnrollments(
    connection: LmsConnection,
    courseId: string,
  ): Promise<LmsEnrollment[]>;
}
