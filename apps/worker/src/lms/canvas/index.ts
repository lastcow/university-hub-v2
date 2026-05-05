// Canvas LMS adapter entry-point (sub-issue UNI-52).
//
// Importing this module registers the default `CanvasProvider` instance
// on the process-wide `lmsProviderRegistry` (side-effect in
// `./provider.ts`). The Worker entry-point (`apps/worker/src/index.ts`)
// imports this so the registry is populated before any LMS route
// handler resolves a provider id.

export {
  CanvasProvider,
  defaultCanvasProvider,
  type CanvasProviderDeps,
} from "./provider.js";
export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type CanvasTokenExchangeResult,
  type CanvasTokenRefreshResult,
} from "./oauth.js";
export {
  listTerms,
  listMyCourses,
  listEnrollments,
  deriveTermsFromCourses,
} from "./api.js";
export {
  CanvasApiError,
  CanvasOAuthError,
  type FetchLike,
  USER_AGENT,
} from "./http.js";
