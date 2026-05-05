// LMS sync types (epic UNI-50 / sub-issue UNI-51).
//
// These shapes describe the substrate the provider abstraction passes
// around. Provider-specific adapters (Canvas first, in sub-issue UNI-52)
// translate their wire format into these types; the reconciliation
// engine (UNI-56) consumes them. Sync UI / endpoints (UNI-55) reuse the
// run + summary shapes for status polling.

import type { Id, IsoDateString } from "./common.js";

/**
 * The fixed set of LMS providers the platform plans to support. Held as
 * a union of literals (rather than a free string) so the registry can
 * key off a closed type, the schema CHECK constraint stays in lock-step
 * with the application code, and unknown values never reach a provider
 * implementation. Sub-issue UNI-51 lands the substrate; UNI-52 wires
 * Canvas; the remaining three are Phase-3 work.
 */
export type LmsProviderId =
  | "canvas"
  | "blackboard"
  | "moodle"
  | "google_classroom";

/** Lifecycle of an `lms_connections` row. */
export type LmsConnectionStatus = "active" | "expired" | "revoked";

/** How the user authenticated against the LMS. `oauth` covers the
 *  standard OAuth Authorization Code dance (with optional refresh
 *  tokens); `pat` covers a long-lived Personal Access Token the user
 *  pastes from the LMS UI. PAT connections leave
 *  `refresh_token_encrypted` NULL — there's no refresh path. Brought
 *  into Phase 1 (was Phase 2) by the user's first-customer Canvas
 *  test target exposing only a PAT. */
export type LmsAuthMethod = "oauth" | "pat";

/** Lifecycle of an `lms_sync_runs` row. */
export type LmsSyncRunStatus =
  | "pending"
  | "running"
  | "success"
  | "partial"
  | "failed";

/** Whether a course / course_assignment / etc. row was entered manually
 *  in Hub or pulled from an LMS sync. LMS-sourced rows are upsert
 *  targets on subsequent syncs (LMS wins; manual edits get overwritten
 *  with a UI warning, per the epic's locked decisions). */
export type LmsRowSource = "manual" | "lms";

/**
 * Per-(university, provider) OAuth client config. Created by a customer
 * admin in Settings → Integrations (UNI-53). The shared secret is
 * field-encrypted on disk (apps/worker/src/crypto/field-encryption.ts);
 * this surface holds the plaintext shape used by the provider methods —
 * the storage row carries `client_secret_encrypted` instead.
 */
export interface LmsProviderConfig {
  id: Id;
  university_id: Id;
  provider_id: LmsProviderId;
  base_url: string;
  client_id: string;
  client_secret: string;
  enabled: boolean;
  configured_by_user_id: Id | null;
  configured_at: IsoDateString;
  updated_at: IsoDateString;
}

/**
 * Per-(user, provider) bearer credential. Provider methods accept this
 * shape with raw decrypted tokens; the storage row carries
 * `access_token_encrypted` / `refresh_token_encrypted` instead.
 *
 * `university_id` is mirrored from the user's home university for
 * tenant-scoped queries (a user's `university_id` could in principle
 * become NULL on archive; the connection still needs a known tenant).
 */
export interface LmsConnection {
  id: Id;
  user_id: Id;
  university_id: Id;
  provider_id: LmsProviderId;
  auth_method: LmsAuthMethod;
  base_url: string;
  access_token: string;
  /** Always null for `auth_method === 'pat'` (no refresh path) and for
   *  OAuth providers that don't issue a refresh token; populated for
   *  the standard OAuth Authorization Code grant. */
  refresh_token: string | null;
  token_expires_at: IsoDateString | null;
  scope: string | null;
  status: LmsConnectionStatus;
  last_synced_at: IsoDateString | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** OAuth credentials supplied at sign-in time, before a connection row
 *  exists. The exact shape is provider-specific; this is the substrate
 *  every authenticate() call accepts. */
export interface LmsAuthCredentials {
  /** Provider-issued authorization code (OAuth Authorization Code grant). */
  code?: string;
  /** Redirect URI sent on the original /authorize request — required by
   *  most OAuth servers as a binding parameter on the token exchange. */
  redirect_uri?: string;
  /** Phase-2 fallback: a Personal Access Token (Canvas etc.). When
   *  present, providers should skip the OAuth dance and store the PAT
   *  as `access_token` directly (no refresh). */
  personal_access_token?: string;
}

/** Term entry returned by a provider's `listTerms`. Maps onto a row in
 *  the `terms` table after reconciliation. */
export interface LmsTerm {
  /** Provider-native id (Canvas's `enrollment_term_id`, etc.). */
  external_id: string;
  name: string;
  start_date: IsoDateString | null;
  end_date: IsoDateString | null;
}

/** Course entry returned by a provider's `listMyCourses`. */
export interface LmsCourse {
  external_id: string;
  /** Provider-native term id; null if the provider doesn't bind the
   *  course to a term (rare; here for shape parity). */
  external_term_id: string | null;
  name: string;
  /** Course code / SIS id (e.g. "CS-101-2025F"). Provider-supplied;
   *  may be missing on hand-rolled LMS courses. */
  code: string | null;
  description: string | null;
}

/** Enrollment entry returned by a provider's `listEnrollments`. */
export interface LmsEnrollment {
  /** Provider-native enrollment id. Optional because some providers do
   *  not expose a stable per-row identifier; reconciliation falls back
   *  to (course, user, role) when null. */
  external_id: string | null;
  /** Provider-native course id this enrollment belongs to. */
  external_course_id: string;
  /** Provider-native user id (the enrolled student / teacher / TA). */
  external_user_id: string;
  /** Email if the provider exposes it. Reconciliation prefers the
   *  external id but falls back to email + university_id when the row
   *  is unknown (per the epic's locked decisions). */
  email: string | null;
  name: string | null;
  /** Mapped to a Hub `course_assignments.role`. Providers that don't
   *  distinguish faculty / teacher use `teacher` by default. */
  role: "faculty" | "teacher" | "teacher_assistant" | "student";
}

/** Per-run counts emitted by the reconciliation engine and surfaced in
 *  the sync UI. Lives in `lms_sync_runs.summary_json`. */
export interface LmsSyncSummary {
  courses_created: number;
  courses_updated: number;
  courses_unchanged: number;
  students_created: number;
  students_matched: number;
  students_invited: number;
  enrollments_created: number;
  enrollments_updated: number;
  enrollments_unchanged: number;
}

/** A single per-row error captured during a sync. Lives in
 *  `lms_sync_runs.error_log_json` as an array of these. */
export interface LmsSyncError {
  /** Hub-side row category the error pertains to. */
  scope: "course" | "enrollment" | "student" | "term" | "connection";
  /** Provider-native id, if known. */
  external_id?: string;
  message: string;
}

/** A persisted run record. */
export interface LmsSyncRun {
  id: Id;
  user_id: Id;
  connection_id: Id;
  term_id: Id | null;
  started_at: IsoDateString;
  completed_at: IsoDateString | null;
  status: LmsSyncRunStatus;
  summary: LmsSyncSummary | null;
  errors: LmsSyncError[] | null;
}

/**
 * Public shape of a provider config row as returned by the admin
 * `GET /api/lms/provider-configs` listing (UNI-53).
 *
 * Critical contract: `client_secret` is **never** returned by any
 * endpoint. Only `client_id_last4` (last 4 chars of the configured
 * `client_id`, masked for display) and `has_client_secret` (boolean
 * presence flag) leak to the client. The encrypted secret stays on the
 * server. The route handler enforces this; the shared shape just makes
 * the omission visible to the type system.
 */
export interface LmsProviderConfigPublic {
  id: Id;
  university_id: Id;
  provider_id: LmsProviderId;
  base_url: string;
  client_id_last4: string;
  has_client_secret: boolean;
  enabled: boolean;
  configured_by_user_id: Id | null;
  configured_at: IsoDateString;
  updated_at: IsoDateString;
}

/**
 * One entry in the registry summary returned by the listing endpoint.
 * Lets the admin UI render every provider in the registry — even those
 * the customer hasn't configured yet — alongside a Configured /
 * Not configured pill, without making the client know the registry's
 * contents up front.
 */
export interface LmsProviderRegistryEntry {
  provider_id: LmsProviderId;
  display_name: string;
  /** The persisted config row, or null when this university hasn't
   *  configured this provider yet. */
  config: LmsProviderConfigPublic | null;
}

export interface LmsProviderConfigsResponse {
  providers: LmsProviderRegistryEntry[];
}

/** Display labels for the registry entries — kept here so the admin UI
 *  doesn't have to hard-code provider name strings. */
export const LMS_PROVIDER_DISPLAY_NAMES: Record<LmsProviderId, string> = {
  canvas: "Canvas",
  blackboard: "Blackboard",
  moodle: "Moodle",
  google_classroom: "Google Classroom",
};

/**
 * Public shape of an `lms_connections` row as returned by
 * `GET /api/lms/connections` (UNI-54). Tokens never leave the Worker —
 * not the access_token, not the refresh_token, not the encrypted blobs.
 * The shape carries enough metadata for the integrations UI to render
 * connection status and last-sync time without exposing the bearer
 * material to the SPA.
 */
export interface LmsConnectionPublic {
  id: Id;
  user_id: Id;
  university_id: Id;
  provider_id: LmsProviderId;
  auth_method: LmsAuthMethod;
  base_url: string;
  status: LmsConnectionStatus;
  scope: string | null;
  /** Absolute ISO-8601 timestamp; null for PAT connections and for
   *  OAuth providers that don't surface an expiry on the token response. */
  token_expires_at: IsoDateString | null;
  last_synced_at: IsoDateString | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

export interface LmsConnectionsResponse {
  connections: LmsConnectionPublic[];
}

/** Successful response of `POST /api/lms/connections/canvas/start`. */
export interface StartLmsConnectionResponse {
  /** Provider-side authorize URL the SPA should redirect the browser
   *  to (`window.location.href = authorize_url`). */
  authorize_url: string;
  /** Echo of the CSRF state token we minted; not strictly needed by
   *  the SPA but useful in dev tooling and browser-based tests. */
  state: string;
  /** Provider id this state is bound to (always 'canvas' on this
   *  endpoint today; here for future-proofing when Phase 3 lands the
   *  other providers). */
  provider_id: LmsProviderId;
}

/** Successful response of `POST /api/lms/connections/:id/disconnect`. */
export interface DisconnectLmsConnectionResponse {
  ok: true;
  connection: LmsConnectionPublic;
}
