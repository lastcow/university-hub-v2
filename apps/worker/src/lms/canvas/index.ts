// Canvas LMS adapter entry-point (sub-issue UNI-52; reshaped in UNI-63
// to drop the OAuth helpers — Canvas now uses per-user Personal Access
// Tokens).
//
// Importing this module registers the default `CanvasProvider` instance
// on the process-wide `lmsProviderRegistry` (side-effect in
// `./provider.ts`). The Worker entry-point (`apps/worker/src/index.ts`)
// imports this so the registry is populated before any LMS route
// handler resolves a provider id.

export {
  CanvasProvider,
  defaultCanvasProvider,
  pickRootAccount,
  type CanvasProviderDeps,
} from "./provider.js";
export {
  type CanvasManageableAccount,
  listTerms,
  listMyCourses,
  listAccountCoursesForTerm,
  listEnrollments,
  listManageableAccounts,
  deriveTermsFromCourses,
  validatePersonalAccessToken,
} from "./api.js";
export {
  CanvasApiError,
  type FetchLike,
  USER_AGENT,
} from "./http.js";
