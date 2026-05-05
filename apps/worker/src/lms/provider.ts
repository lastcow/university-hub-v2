// LMS provider abstraction (epic UNI-50; reshaped in UNI-63 to drop
// the OAuth refresh path).
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
//
// UNI-63 dropped `refreshToken` from the surface. Canvas uses a per-
// user Personal Access Token now — there is no refresh exchange. If a
// future provider lands an OAuth-shaped flow, refresh will go through
// a separate optional capability extension rather than reappearing
// here, so PAT-only providers don't have to implement a no-op.
//
// Phase 1 is read-only by design (per the user's locked decision in the
// epic). The four methods below are the entire surface — there is no
// `pushGrades`, `pushAssignment`, etc. here, and the `LmsProvider` type
// must not grow one. Bidirectional providers come in Phase 4 as a
// separate `LmsWriteProvider` extension that an LMS adapter opts into;
// keeping write capability off this base interface lets a Phase-1
// provider implementation declare it conformant without claiming any
// write surface it doesn't have.

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
   * Validate user-supplied credentials against the provider and return
   * an authenticated connection. The returned `LmsConnection` carries
   * the plaintext access token — the caller is responsible for field-
   * encrypting it before it lands in `lms_connections`.
   *
   * UNI-63: for Canvas, this probes `<base_url>/api/v1/users/self`
   * with the supplied PAT before returning. A 401 throws so the
   * caller can surface "invalid token" without persisting anything.
   */
  authenticate(
    creds: LmsAuthCredentials,
    providerConfig: LmsProviderConfig,
  ): Promise<LmsConnection>;

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
