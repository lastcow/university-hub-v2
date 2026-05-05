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
 *  the sync UI. Lives in `lms_sync_runs.summary_json`.
 *
 *  Phase 1 lock (UNI-56): `students_invited` is **always 0**. The
 *  reconciliation engine does not send invitation emails — synced
 *  students are auto-created with `status = 'pending'` and a future
 *  Phase-2 admin-driven bulk-invitation UI fills this counter. The
 *  field is kept on the type so the SPA's completion summary doesn't
 *  have to be reshuffled when Phase 2 lands. */
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
  /** Course assignments soft-deleted because the LMS no longer reports
   *  them in the term's roster. Rows are flipped to `status = 'dropped'`
   *  rather than physically removed so the audit trail and FERPA
   *  record-of-disclosure chain are preserved. */
  enrollments_dropped: number;
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

/** A non-error advisory captured during a sync. Today the only kind
 *  is "manual edit overwritten" — the engine detects rows that were
 *  hand-edited since the last sync (per the epic's locked decision the
 *  LMS still wins on re-sync, but the UI should warn the user). The
 *  shape is open-ended via the `reason` discriminator so future
 *  conflict kinds (e.g. `cross_provider_collision`) can extend it
 *  without a breaking change. */
export interface LmsSyncConflict {
  course_external_id: string;
  course_name: string;
  reason: "manual_edit_overwritten";
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
  conflicts: LmsSyncConflict[] | null;
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

/**
 * Public, non-admin entry for `GET /api/lms/provider-configs/enabled`
 * (UNI-54). The user-facing /app/integrations page reads this — every
 * authenticated user role can call the endpoint, scoped to their own
 * university and filtered to enabled rows. The shape carries only
 * what the SPA needs to render a Connect card; admin-relevant fields
 * (`client_id_last4`, `has_client_secret`, `configured_*`) are NOT
 * exposed here.
 */
export interface LmsEnabledProvider {
  provider_id: LmsProviderId;
  display_name: string;
  base_url: string;
}

export interface LmsEnabledProvidersResponse {
  providers: LmsEnabledProvider[];
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

// ---------------------------------------------------------------------------
// Sync orchestration (UNI-55).
//
// Five endpoints back the sync UI: list-terms (proxy to the provider),
// preview-counts (no writes), kick-off, get-by-id (UI polling), list
// caller's recent runs. The reconciliation/upsert engine itself is
// UNI-56; this surface is the orchestration shell that drives a
// `lms_sync_runs` row through its lifecycle.
// ---------------------------------------------------------------------------

/** Element of `GET /api/lms/connections/:id/terms` response — provider
 *  term as the SPA sees it. The Canvas (and future) adapter normalizes
 *  to `LmsTerm`; this surface adds nothing on top. Aliased so the SPA
 *  doesn't have to import the provider-substrate name. */
export type LmsConnectionTerm = LmsTerm;

export interface LmsConnectionTermsResponse {
  /** Provider id this term list belongs to (echoes the connection's
   *  provider, present so the UI doesn't have to thread it through). */
  provider_id: LmsProviderId;
  terms: LmsConnectionTerm[];
}

/** Body of `POST /api/lms/sync-runs/preview` and `POST /api/lms/sync-runs`. */
export interface LmsSyncRunInput {
  connection_id: Id;
  /** Provider-native term id (`LmsTerm.external_id`) the user picked. */
  term_id: string;
}

/** Successful response of `POST /api/lms/sync-runs/preview`. Read-only —
 *  no row is created. The estimates are derived from a single network
 *  round-trip per course (first page only, per the issue spec) so a
 *  preview against a 100-course term doesn't fan out to a full sync. */
export interface LmsSyncPreviewResponse {
  connection_id: Id;
  term_id: string;
  /** Display label for the picked term. Pulled from the cached provider
   *  term list so the UI doesn't need a second round-trip to render
   *  "Importing Fall 2026 — 12 courses, ~340 students". */
  term_name: string | null;
  courses: number;
  students_total: number;
  /** Estimate of how many of `students_total` are not yet Hub users.
   *  Best-effort — the precise figure lands after reconciliation runs.
   *  The preview path matches against `users.email` only (it does not
   *  consult `(external_provider, external_id)`), so it slightly
   *  overcounts when a Hub row was previously imported under a
   *  different email but reconciled by external id. UNI-56 narrows
   *  this; for the preview shell we surface it as ~estimate. */
  students_new_estimate: number;
  /** Estimate of how many of `courses` are not yet Hub courses, by
   *  `(external_provider, external_id)` lookup. */
  courses_new_estimate: number;
  /** When the preview reads only the first page of enrollments per
   *  course, set true so the SPA can render "+~" alongside the count. */
  truncated: boolean;
}

/** Per-run progress signal stored in `summary_json.progress` while a
 *  run is `running`. The stub runner (UNI-55) emits the four standard
 *  steps below; UNI-56's reconciliation engine will emit finer-grained
 *  values as it touches each course. */
export interface LmsSyncRunProgress {
  current_step: number;
  total_steps: number;
  /** Short human-readable label for the current step, surfaced in the
   *  UI's progress view ("Listing courses", "Reconciling enrollments",
   *  etc.). */
  label: string | null;
}

/** Successful response of `POST /api/lms/sync-runs`. Returns the new
 *  row's id immediately; the SPA polls `GET /api/lms/sync-runs/:id` to
 *  watch progress. */
export interface CreateLmsSyncRunResponse {
  sync_run_id: Id;
  status: LmsSyncRunStatus;
}

/** Public shape of an `lms_sync_runs` row as returned by
 *  `GET /api/lms/sync-runs/:id` and the listing endpoint. The persisted
 *  `summary_json` / `error_log_json` strings are parsed before the
 *  response goes out so the SPA never has to JSON.parse a column. */
export interface LmsSyncRunPublic {
  id: Id;
  user_id: Id;
  connection_id: Id;
  term_id: string | null;
  /** Human-readable name copied from the term catalog at run time. Null
   *  when the run was started against an LMS-only term that the Hub
   *  hasn't reconciled yet. */
  term_name: string | null;
  started_at: IsoDateString;
  completed_at: IsoDateString | null;
  status: LmsSyncRunStatus;
  summary: LmsSyncSummary | null;
  errors: LmsSyncError[] | null;
  /** Non-error advisories emitted by the reconciliation engine. The
   *  SPA renders these as warnings on the completion summary. */
  conflicts: LmsSyncConflict[] | null;
  progress: LmsSyncRunProgress | null;
}

export interface LmsSyncRunResponse {
  sync_run: LmsSyncRunPublic;
}

export interface LmsSyncRunsResponse {
  sync_runs: LmsSyncRunPublic[];
}

// ---------------------------------------------------------------------------
// Onboarding hook (UNI-57).
//
// `GET /api/onboarding/lms-step` evaluates four gates server-side:
//
//   1. Caller's role is in { faculty, teacher, teacher_assistant }.
//   2. At least one provider is configured + enabled at their university.
//   3. Caller hasn't yet connected (no active `lms_connections` row).
//   4. Caller hasn't dismissed the step (`users.lms_onboarding_dismissed_at`
//      IS NULL).
//
// All four must pass for `show: true`. Otherwise `show: false` plus a
// `reason` discriminator the SPA can use to log decisions in dev tools
// (the SPA never branches on it user-facing — `show: false` always means
// "skip the step and go to the dashboard").
// ---------------------------------------------------------------------------

export type LmsOnboardingSkipReason =
  /** Role outside the teaching set. */
  | "ineligible_role"
  /** University has no enabled provider configured. */
  | "no_provider_enabled"
  /** Caller already connected; the integrations page handles re-sync. */
  | "already_connected"
  /** Caller previously skipped or connected, then re-signed in. */
  | "dismissed"
  /** Caller's `university_id` is null (e.g. super_admin without a home
   *  tenant). Treated like `ineligible_role`; surfaced as a separate
   *  reason so the dev-tools log makes the cause obvious. */
  | "no_university";

export interface LmsOnboardingStepResponse {
  show: boolean;
  /** Present whenever `show === false` so the SPA's debug logging can
   *  distinguish the four skip causes. Never present when `show === true`. */
  reason?: LmsOnboardingSkipReason;
  /** Enabled providers at the caller's university — empty array when the
   *  step is hidden. Same shape as the listing returned by
   *  `GET /api/lms/provider-configs/enabled` so the SPA can reuse the
   *  existing `LmsEnabledProvider` rendering primitives. */
  providers: LmsEnabledProvider[];
}

export interface DismissLmsOnboardingResponse {
  ok: true;
  /** Echo of the timestamp the row was stamped with, in case the caller
   *  wants to surface a "skipped at" message. Always non-null. */
  dismissed_at: IsoDateString;
}
