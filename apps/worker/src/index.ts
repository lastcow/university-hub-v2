import type { HealthResponse } from "@university-hub/shared";

import type { Env } from "./env.js";
// Side-effect import: registers the default Canvas provider on the
// process-wide LMS provider registry (sub-issue UNI-52). Phase-3
// providers (Blackboard, Moodle, Google Classroom) will register the
// same way.
import "./lms/canvas/index.js";
import { buildContext } from "./middleware/auth.js";
import {
  applyGenericLimit,
  rateLimitedResponse,
} from "./middleware/rate-limit.js";
import {
  handleAssessmentAnalyticsSummary,
  handleCourseAnalyticsSummary,
} from "./routes/analytics.js";
import {
  handleCreateAssessment,
  handleDeleteAssessment,
  handleListAssessments,
  handleUpdateAssessment,
} from "./routes/assessments.js";
import { handleListAuditLogs } from "./routes/audit-logs.js";
import {
  handleCreateDisclosureConsent,
  handleListDisclosureConsents,
  handleRevokeDisclosureConsent,
} from "./routes/disclosure-consents.js";
import {
  handleListDisclosures,
  handleRecordDisclosure,
} from "./routes/disclosures.js";
import { handleListGradeAccessLog } from "./routes/grade-access-log.js";
import {
  handleAcceptLegal,
  handleGetAcknowledgmentStatus,
  handleGetLegalAdmin,
  handleGetLegalDocument,
  handleUpdateLegalDocument,
} from "./routes/legal.js";
import {
  handleParentGrades,
  handleParentMe,
  handleParentSignInRequest,
  handleParentSignInVerify,
  handleParentSignOut,
} from "./routes/parent-auth.js";
import {
  handleCreateGrade,
  handleListCourseGrades,
  handleListStudentGrades,
  handleUpdateGrade,
} from "./routes/grades.js";
import {
  handleMe,
  handlePasswordResetRequest,
  handleSignIn,
  handleSignOut,
} from "./routes/auth.js";
import {
  handleMfaChallenge,
  handleMfaDisable,
  handleMfaEnroll,
  handleMfaRegenerateRecoveryCodes,
  handleMfaStatus,
  handleMfaVerifyEnroll,
} from "./routes/mfa.js";
import { handleBootstrapSuperAdmin } from "./routes/bootstrap.js";
import { handleCreateContactMessage } from "./routes/contact.js";
import {
  handleListSessions,
  handleRevokeAllOtherSessions,
  handleRevokeSession,
} from "./routes/sessions.js";
import { handleListEmailLogs } from "./routes/email-logs.js";
import {
  handleListEscalationContacts,
  handleUpdateEscalationContact,
} from "./routes/escalation-contacts.js";
import {
  handleDeleteLmsProviderConfig,
  handleListEnabledLmsProviders,
  handleListLmsProviderConfigs,
  handleUpsertLmsProviderConfig,
} from "./routes/lms-provider-configs.js";
import {
  handleConnectCanvasConnection,
  handleDisconnectLmsConnection,
  handleListLmsConnections,
} from "./routes/lms-connections.js";
import {
  handleCreateLmsSyncRun,
  handleGetLmsSyncRun,
  handleListLmsConnectionTerms,
  handleListLmsSyncRuns,
  handleLmsSyncRunPreview,
} from "./routes/lms-sync-runs.js";
import {
  handleDismissOnboardingLmsStep,
  handleGetOnboardingLmsStep,
} from "./routes/onboarding.js";
import {
  handleCreateCourse,
  handleCreateCourseAssignment,
  handleDeleteCourse,
  handleDeleteCourseAssignment,
  handleGetCourse,
  handleListCourseAssignments,
  handleListCourses,
  handleUpdateCourse,
} from "./routes/courses.js";
import { handleDashboardSummary } from "./routes/dashboard.js";
import {
  handleCreateDepartment,
  handleDeleteDepartment,
  handleGetDepartment,
  handleListDepartments,
  handleUpdateDepartment,
} from "./routes/departments.js";
import {
  handleAcceptInvitation,
  handleCreateInvitation,
  handleGetInvitation,
  handleListInvitations,
  handleLookupInvitation,
  handleResendInvitation,
  handleRevokeInvitation,
} from "./routes/invitations.js";
import {
  handleGetFaculty,
  handleGetMyFaculty,
  handleListFaculty,
} from "./routes/faculty.js";
import {
  handleGetMyStudent,
  handleGetStudent,
  handleListMyStudentCourses,
  handleListStudents,
  handleUpdateStudentDirectoryInfo,
} from "./routes/students.js";
import {
  handleGetMyTeacherAssistant,
  handleGetTeacherAssistant,
  handleListMyTeacherAssistantCourses,
  handleListTeacherAssistantCourses,
  handleListTeacherAssistants,
} from "./routes/teacher-assistants.js";
import {
  handleGetMyTeacher,
  handleGetTeacher,
  handleListMyTeacherCourses,
  handleListMyTeacherStudents,
  handleListTeacherCourses,
  handleListTeacherStudents,
  handleListTeachers,
} from "./routes/teachers.js";
import {
  handleGetMailgunStatus,
  handleGetSystemSettings,
  handleGetSystemStatus,
  handleUpdateAccountSettings,
  handleUpdateSystemSettings,
  handleUpdateUniversitySettings,
} from "./routes/settings.js";
import {
  handleAdminListTrustedDevices,
  handleAdminRevokeAllTrustedDevices,
  handleListTrustedDevices,
  handleRevokeAllTrustedDevices,
  handleRevokeTrustedDevice,
} from "./routes/trusted-devices.js";
import {
  handleCreateUniversity,
  handleGetUniversity,
  handleListUniversities,
  handleUpdateUniversity,
} from "./routes/universities.js";
import {
  handleDeleteUser,
  handleGetUser,
  handleListUsers,
  handleUpdateUser,
  handleUpdateUserRole,
  handleUpdateUserStatus,
} from "./routes/users.js";
import { runScheduledBackup } from "./services/backup.js";
import { runScheduledRetention } from "./services/retention.js";
import { buildPreflightResponse, withCors } from "./utils/cors.js";
import { errorResponse, jsonOk } from "./utils/responses.js";

export type { Env } from "./env.js";

const INVITATION_ID_RE =
  /^\/api\/invitations\/([0-9a-fA-F-]{36})(?:\/(revoke|resend))?\/?$/;
const UNIVERSITY_ID_RE = /^\/api\/universities\/([0-9a-fA-F-]{36})\/?$/;
const USER_ID_RE = /^\/api\/users\/([0-9a-fA-F-]{36})(?:\/(role|status))?\/?$/;
const DEPARTMENT_ID_RE = /^\/api\/departments\/([0-9a-fA-F-]{36})\/?$/;
const COURSE_ID_RE = /^\/api\/courses\/([0-9a-fA-F-]{36})\/?$/;
const COURSE_ASSIGNMENT_RE =
  /^\/api\/courses\/([0-9a-fA-F-]{36})\/assignments(?:\/([0-9a-fA-F-]{36}))?\/?$/;
const COURSE_ASSESSMENTS_RE =
  /^\/api\/courses\/([0-9a-fA-F-]{36})\/assessments\/?$/;
const COURSE_GRADES_RE =
  /^\/api\/courses\/([0-9a-fA-F-]{36})\/grades\/?$/;
const COURSE_ANALYTICS_SUMMARY_RE =
  /^\/api\/courses\/([0-9a-fA-F-]{36})\/analytics\/summary\/?$/;
const COURSE_ANALYTICS_ASSESSMENT_RE =
  /^\/api\/courses\/([0-9a-fA-F-]{36})\/analytics\/assessment\/([0-9a-fA-F-]{36})\/?$/;
const ASSESSMENT_ID_RE = /^\/api\/assessments\/([0-9a-fA-F-]{36})\/?$/;
const GRADE_ID_RE = /^\/api\/grades\/([0-9a-fA-F-]{36})\/?$/;
const STUDENT_GRADES_RE =
  /^\/api\/students\/([0-9a-fA-F-]{36})\/grades\/?$/;
const STUDENT_DIRECTORY_INFO_RE =
  /^\/api\/students\/([0-9a-fA-F-]{36})\/directory-info\/?$/;
const STUDENT_ID_RE = /^\/api\/students\/([0-9a-fA-F-]{36})\/?$/;
const DISCLOSURE_CONSENT_REVOKE_RE =
  /^\/api\/disclosure-consents\/([0-9a-fA-F-]{36})\/revoke\/?$/;
const FACULTY_ID_RE = /^\/api\/faculty\/([0-9a-fA-F-]{36})\/?$/;
const TEACHER_ID_RE =
  /^\/api\/teachers\/([0-9a-fA-F-]{36})(?:\/(courses|students))?\/?$/;
const TEACHER_ASSISTANT_ID_RE =
  /^\/api\/teacher-assistants\/([0-9a-fA-F-]{36})(?:\/(courses))?\/?$/;
const SESSION_ID_RE = /^\/api\/auth\/sessions\/([0-9a-fA-F-]{36})\/?$/;
const TRUSTED_DEVICE_ID_RE =
  /^\/api\/auth\/trusted-devices\/([0-9a-fA-F-]{36})\/?$/;
const USER_TRUSTED_DEVICES_RE =
  /^\/api\/users\/([0-9a-fA-F-]{36})\/trusted-devices(?:\/(revoke-all))?\/?$/;
const LEGAL_KIND_RE = /^\/api\/legal\/(terms|privacy)\/?$/;
const LEGAL_ADMIN_KIND_RE = /^\/api\/legal\/admin\/(terms|privacy)\/?$/;
const ESCALATION_CONTACT_RE = /^\/api\/escalation-contacts\/([a-z_]+)\/?$/;
const LMS_PROVIDER_CONFIG_ID_RE =
  /^\/api\/lms\/provider-configs\/([0-9a-fA-F-]{36})\/?$/;
const LMS_CONNECTION_DISCONNECT_RE =
  /^\/api\/lms\/connections\/([0-9a-fA-F-]{36})\/disconnect\/?$/;
const LMS_CONNECTION_TERMS_RE =
  /^\/api\/lms\/connections\/([0-9a-fA-F-]{36})\/terms\/?$/;
const LMS_SYNC_RUN_ID_RE =
  /^\/api\/lms\/sync-runs\/([0-9a-fA-F-]{36})\/?$/;

export default {
  async fetch(request, env, executionCtx): Promise<Response> {
    const url = new URL(request.url);

    // The Worker is API-only — the SPA ships from a separate Cloudflare
    // Pages project. Anything outside `/api/*` returns a small JSON 404
    // rather than a redirect or proxy; the browser only ever lands here
    // via a direct API call or an accidental visit to the Worker host.
    if (!url.pathname.startsWith("/api/")) {
      return withCors(
        errorResponse(
          404,
          "not_found",
          "This is the University Hub API. The web app lives on the Pages project — see docs/deployment.md.",
        ),
        env,
        request,
      );
    }

    // CORS preflight runs before context/auth work — it never carries cookies
    // and only needs to inspect headers.
    if (request.method === "OPTIONS") {
      return buildPreflightResponse(env, request);
    }

    // Every non-OPTIONS path returns through `withCors` below — including the
    // 500 fallback. The browser only enforces CORS on the response, so a
    // route handler that throws unexpectedly must not escape un-wrapped or
    // the SPA console fills with the misleading "No Access-Control-Allow-
    // Origin" error instead of the real 5xx that the user can act on.
    let response: Response;
    try {
      const ctx = await buildContext(request, env, executionCtx);

      // Generic API rate limit (UNI-25). Authenticated callers get a
      // per-session bucket (~120 req/min); everyone else a per-IP bucket
      // (~30 req/min). Skips /api/health. Per-route stricter limits
      // (sign-in, MFA challenge, password reset, invitation resend) run
      // inside the route handlers.
      const generic = await applyGenericLimit(ctx);
      if (generic && !generic.allowed) {
        response = rateLimitedResponse(
          generic,
          "Too many requests. Slow down and try again shortly.",
        );
      } else {
        response = await routeApi(ctx, request, env, url);
      }
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      console.error("api_unhandled_error", {
        pathname: url.pathname,
        method: request.method,
        message: cause.message,
        stack: cause.stack,
      });
      response = errorResponse(
        500,
        "internal_error",
        "An unexpected error occurred while handling the request.",
      );
    }
    return withCors(response, env, request);
  },

  // Cron Trigger handler. Cloudflare can fire multiple cron expressions
  // at this Worker; we dispatch by `event.cron`:
  //
  //   - "0 2 * * *"   (UNI-27, defense-in-depth) — D1 → R2 backup. The
  //                   block in wrangler.toml is commented out until R2 is
  //                   enabled on the account; until then the canonical
  //                   scheduler is the GitHub Actions workflow.
  //   - "30 2 * * *"  (UNI-33) — nightly retention sweep. Always active.
  //
  // Each branch logs a structured line so `wrangler tail` shows what ran
  // and how many rows moved. Failures are non-fatal — we don't want a
  // single bad sweep to put the cron into an alert loop.
  async scheduled(event, env, ctx): Promise<void> {
    const cron = event.cron;
    const work = (async () => {
      if (cron === "0 2 * * *") {
        try {
          const result = await runScheduledBackup(env);
          const tag = result.ok ? "ok" : "skipped";
          console.log(`[cron:d1-backup] ${tag} ${JSON.stringify(result)}`);
        } catch (err) {
          console.error(
            `[cron:d1-backup] failed: ${(err as Error).message}\n${(err as Error).stack ?? ""}`,
          );
        }
        return;
      }
      if (cron === "30 2 * * *") {
        try {
          const result = await runScheduledRetention(env);
          const tag = result.ok ? "ok" : "partial";
          console.log(`[cron:retention] ${tag} ${JSON.stringify(result)}`);
        } catch (err) {
          console.error(
            `[cron:retention] failed: ${(err as Error).message}\n${(err as Error).stack ?? ""}`,
          );
        }
        return;
      }
      console.warn(`[cron] unknown schedule fired: ${cron}`);
    })();
    ctx.waitUntil(work);
  },
} satisfies ExportedHandler<Env>;

async function routeApi(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {

    if (url.pathname === "/api/health" && request.method === "GET") {
      const body: HealthResponse = {
        ok: true,
        service: "university-hub-worker",
        timestamp: new Date().toISOString(),
      };
      return jsonOk(body);
    }

    // Production bootstrap (UNI-16). Disabled (returns 404) unless
    // BOOTSTRAP_SECRET is set; the endpoint also self-disables once any
    // super_admin row exists. See routes/bootstrap.ts for the full gate.
    if (
      url.pathname === "/api/bootstrap/super-admin" &&
      request.method === "POST"
    ) {
      return handleBootstrapSuperAdmin(ctx);
    }

    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      return handleSignIn(ctx);
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      return handleSignOut(ctx);
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      return handleMe(ctx);
    }
    // Password-reset request endpoint (UNI-25). Stub today — always 202 with
    // a generic message regardless of account existence — but the per-email
    // rate limiter is wired so credential-stuffing reconnaissance can't
    // probe addresses, and so an actual password-reset feature can plug in
    // here later without revisiting the abuse surface.
    if (
      url.pathname === "/api/auth/password-reset/request" &&
      request.method === "POST"
    ) {
      return handlePasswordResetRequest(ctx);
    }

    // MFA endpoints (UNI-24). Enroll/verify-enroll/challenge consume the
    // short-lived MFA challenge cookie; status/disable/regenerate consume
    // the regular session cookie.
    if (url.pathname === "/api/auth/mfa/enroll" && request.method === "POST") {
      return handleMfaEnroll(ctx);
    }
    if (
      url.pathname === "/api/auth/mfa/verify-enroll" &&
      request.method === "POST"
    ) {
      return handleMfaVerifyEnroll(ctx);
    }
    if (url.pathname === "/api/auth/mfa/challenge" && request.method === "POST") {
      return handleMfaChallenge(ctx);
    }
    if (url.pathname === "/api/auth/mfa/status" && request.method === "GET") {
      return handleMfaStatus(ctx);
    }
    if (
      url.pathname === "/api/auth/mfa/recovery-codes" &&
      request.method === "POST"
    ) {
      return handleMfaRegenerateRecoveryCodes(ctx);
    }
    if (url.pathname === "/api/auth/mfa/disable" && request.method === "POST") {
      return handleMfaDisable(ctx);
    }

    // Active sessions surface (UNI-26). Static `/revoke-all` first so the
    // id regex below doesn't try to parse it as a UUID.
    if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
      return handleListSessions(ctx);
    }
    if (
      url.pathname === "/api/auth/sessions/revoke-all" &&
      request.method === "POST"
    ) {
      return handleRevokeAllOtherSessions(ctx);
    }
    const sessionMatch = SESSION_ID_RE.exec(url.pathname);
    if (sessionMatch && request.method === "DELETE") {
      return handleRevokeSession(ctx, sessionMatch[1] as string);
    }

    // Trusted-device management surface (UNI-47). Static `/revoke-all`
    // first so the per-id regex doesn't try to interpret it as a UUID.
    if (
      url.pathname === "/api/auth/trusted-devices" &&
      request.method === "GET"
    ) {
      return handleListTrustedDevices(ctx);
    }
    if (
      url.pathname === "/api/auth/trusted-devices/revoke-all" &&
      request.method === "POST"
    ) {
      return handleRevokeAllTrustedDevices(ctx);
    }
    const trustedDeviceMatch = TRUSTED_DEVICE_ID_RE.exec(url.pathname);
    if (trustedDeviceMatch && request.method === "DELETE") {
      return handleRevokeTrustedDevice(
        ctx,
        trustedDeviceMatch[1] as string,
      );
    }
    const userTrustedDevicesMatch = USER_TRUSTED_DEVICES_RE.exec(url.pathname);
    if (userTrustedDevicesMatch) {
      const targetUserId = userTrustedDevicesMatch[1] as string;
      const sub = userTrustedDevicesMatch[2];
      if (!sub && request.method === "GET") {
        return handleAdminListTrustedDevices(ctx, targetUserId);
      }
      if (sub === "revoke-all" && request.method === "POST") {
        return handleAdminRevokeAllTrustedDevices(ctx, targetUserId);
      }
    }

    if (url.pathname === "/api/dashboard/summary" && request.method === "GET") {
      return handleDashboardSummary(ctx);
    }

    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleCreateContactMessage(ctx);
    }

    // Settings (UNI-15). Static paths only; no path params.
    if (
      url.pathname === "/api/settings/system-status" &&
      request.method === "GET"
    ) {
      return handleGetSystemStatus(ctx);
    }
    if (
      url.pathname === "/api/settings/mailgun-status" &&
      request.method === "GET"
    ) {
      return handleGetMailgunStatus(ctx);
    }
    if (
      url.pathname === "/api/settings/university" &&
      request.method === "PATCH"
    ) {
      return handleUpdateUniversitySettings(ctx);
    }
    if (
      url.pathname === "/api/settings/account" &&
      request.method === "PATCH"
    ) {
      return handleUpdateAccountSettings(ctx);
    }
    // System settings (UNI-47). Read for super_admin / university_admin;
    // edit for super_admin only.
    if (url.pathname === "/api/settings/system" && request.method === "GET") {
      return handleGetSystemSettings(ctx);
    }
    if (
      url.pathname === "/api/settings/system" &&
      request.method === "PATCH"
    ) {
      return handleUpdateSystemSettings(ctx);
    }

    // Privacy policy + ToS surfaces (UNI-34). Static admin paths (and the
    // acknowledgment-status / accept routes) come before the generic
    // `/api/legal/:kind` regex so they don't get swallowed by it.
    if (
      url.pathname === "/api/legal/acknowledgment-status" &&
      request.method === "GET"
    ) {
      return handleGetAcknowledgmentStatus(ctx);
    }
    if (url.pathname === "/api/legal/accept" && request.method === "POST") {
      return handleAcceptLegal(ctx);
    }
    if (url.pathname === "/api/legal/admin" && request.method === "GET") {
      return handleGetLegalAdmin(ctx);
    }
    const legalAdminMatch = LEGAL_ADMIN_KIND_RE.exec(url.pathname);
    if (legalAdminMatch && request.method === "PATCH") {
      return handleUpdateLegalDocument(ctx, legalAdminMatch[1] as string);
    }
    const legalKindMatch = LEGAL_KIND_RE.exec(url.pathname);
    if (legalKindMatch && request.method === "GET") {
      return handleGetLegalDocument(ctx, legalKindMatch[1] as string);
    }

    // Escalation contacts (UNI-40). Static path before the per-key regex
    // so a request to `/api/escalation-contacts` doesn't get dropped on
    // the floor by the path-parameter matcher.
    if (
      url.pathname === "/api/escalation-contacts" &&
      request.method === "GET"
    ) {
      return handleListEscalationContacts(ctx);
    }
    const escalationContactMatch = ESCALATION_CONTACT_RE.exec(url.pathname);
    if (escalationContactMatch && request.method === "PATCH") {
      return handleUpdateEscalationContact(
        ctx,
        escalationContactMatch[1] as string,
      );
    }

    // LMS provider configs (UNI-53). Per-university OAuth client config
    // for each LMS integration. RBAC + tenant scoping live in the
    // handlers; the /:id DELETE form is matched via a UUID regex so
    // the static-path collection routes don't get swallowed.
    //
    // The `/enabled` sub-path is the user-facing public listing (UNI-54)
    // — any authenticated user can read it, scoped to their own
    // university and filtered to enabled rows. It must match BEFORE the
    // bare `/api/lms/provider-configs` GET so admin-only handler doesn't
    // 403 non-admin users on this side endpoint.
    if (
      url.pathname === "/api/lms/provider-configs/enabled" &&
      request.method === "GET"
    ) {
      return handleListEnabledLmsProviders(ctx);
    }
    if (
      url.pathname === "/api/lms/provider-configs" &&
      request.method === "GET"
    ) {
      return handleListLmsProviderConfigs(ctx);
    }
    if (
      url.pathname === "/api/lms/provider-configs" &&
      request.method === "POST"
    ) {
      return handleUpsertLmsProviderConfig(ctx);
    }
    const lmsProviderConfigMatch = LMS_PROVIDER_CONFIG_ID_RE.exec(
      url.pathname,
    );
    if (lmsProviderConfigMatch && request.method === "DELETE") {
      return handleDeleteLmsProviderConfig(
        ctx,
        lmsProviderConfigMatch[1] as string,
      );
    }

    // LMS user connections (UNI-54; PAT flow per UNI-63). Static
    // collection paths and the Canvas-specific connect endpoint match
    // before the per-id `/disconnect` regex so the static segments
    // don't get parsed as UUIDs.
    if (
      url.pathname === "/api/lms/connections" &&
      request.method === "GET"
    ) {
      return handleListLmsConnections(ctx);
    }
    if (
      url.pathname === "/api/lms/connections/canvas" &&
      request.method === "POST"
    ) {
      return handleConnectCanvasConnection(ctx);
    }
    const lmsConnectionDisconnectMatch = LMS_CONNECTION_DISCONNECT_RE.exec(
      url.pathname,
    );
    if (lmsConnectionDisconnectMatch && request.method === "POST") {
      return handleDisconnectLmsConnection(
        ctx,
        lmsConnectionDisconnectMatch[1] as string,
      );
    }
    const lmsConnectionTermsMatch = LMS_CONNECTION_TERMS_RE.exec(
      url.pathname,
    );
    if (lmsConnectionTermsMatch && request.method === "GET") {
      return handleListLmsConnectionTerms(
        ctx,
        lmsConnectionTermsMatch[1] as string,
      );
    }

    // LMS sync orchestration (UNI-55). Static collection paths first so
    // `/preview` doesn't get parsed as a UUID by the per-id regex.
    if (
      url.pathname === "/api/lms/sync-runs" &&
      request.method === "GET"
    ) {
      return handleListLmsSyncRuns(ctx);
    }
    if (
      url.pathname === "/api/lms/sync-runs/preview" &&
      request.method === "POST"
    ) {
      return handleLmsSyncRunPreview(ctx);
    }
    if (
      url.pathname === "/api/lms/sync-runs" &&
      request.method === "POST"
    ) {
      return handleCreateLmsSyncRun(ctx);
    }
    const lmsSyncRunMatch = LMS_SYNC_RUN_ID_RE.exec(url.pathname);
    if (lmsSyncRunMatch && request.method === "GET") {
      return handleGetLmsSyncRun(ctx, lmsSyncRunMatch[1] as string);
    }

    // Onboarding hooks (UNI-57). Post-MFA "Connect your LMS" step.
    if (
      url.pathname === "/api/onboarding/lms-step" &&
      request.method === "GET"
    ) {
      return handleGetOnboardingLmsStep(ctx);
    }
    if (
      url.pathname === "/api/onboarding/lms-step/dismiss" &&
      request.method === "POST"
    ) {
      return handleDismissOnboardingLmsStep(ctx);
    }

    // Logs admin (UNI-14). Read-only; RBAC + university scoping inside the
    // handlers (super_admin + university_admin for both; staff also reads
    // audit logs but never email logs).
    if (url.pathname === "/api/audit-logs" && request.method === "GET") {
      return handleListAuditLogs(ctx);
    }
    if (url.pathname === "/api/email-logs" && request.method === "GET") {
      return handleListEmailLogs(ctx);
    }

    // FERPA record-of-access (UNI-30). Admin-only audit of grade
    // disclosures, distinct from operational audit_logs.
    if (
      url.pathname === "/api/grade-access-log" &&
      request.method === "GET"
    ) {
      return handleListGradeAccessLog(ctx);
    }

    // FERPA controls (UNI-32). Disclosure consents + disclosure log + parent
    // sign-in. Static paths first so the per-id regexes don't try to swallow
    // `/revoke`, `/sign-in/...`, etc. as UUIDs.
    if (
      url.pathname === "/api/disclosure-consents" &&
      request.method === "GET"
    ) {
      return handleListDisclosureConsents(ctx);
    }
    if (
      url.pathname === "/api/disclosure-consents" &&
      request.method === "POST"
    ) {
      return handleCreateDisclosureConsent(ctx);
    }
    const disclosureConsentRevokeMatch = DISCLOSURE_CONSENT_REVOKE_RE.exec(
      url.pathname,
    );
    if (disclosureConsentRevokeMatch && request.method === "POST") {
      return handleRevokeDisclosureConsent(
        ctx,
        disclosureConsentRevokeMatch[1] as string,
      );
    }
    if (url.pathname === "/api/disclosures" && request.method === "GET") {
      return handleListDisclosures(ctx);
    }
    if (url.pathname === "/api/disclosures" && request.method === "POST") {
      return handleRecordDisclosure(ctx);
    }

    // Parent / guardian sign-in surface (UNI-32). The parent has no `users`
    // row; a separate cookie + session table backs every endpoint here.
    if (
      url.pathname === "/api/parent/sign-in/request" &&
      request.method === "POST"
    ) {
      return handleParentSignInRequest(ctx);
    }
    if (
      url.pathname === "/api/parent/sign-in/verify" &&
      request.method === "POST"
    ) {
      return handleParentSignInVerify(ctx);
    }
    if (url.pathname === "/api/parent/sign-out" && request.method === "POST") {
      return handleParentSignOut(ctx);
    }
    if (url.pathname === "/api/parent/me" && request.method === "GET") {
      return handleParentMe(ctx);
    }
    if (url.pathname === "/api/parent/grades" && request.method === "GET") {
      return handleParentGrades(ctx);
    }

    // Invitation routes. Static paths first so the id-matching regex below
    // doesn't try to interpret e.g. `accept` / `lookup` as a UUID.
    if (url.pathname === "/api/invitations" && request.method === "GET") {
      return handleListInvitations(ctx);
    }
    if (url.pathname === "/api/invitations" && request.method === "POST") {
      return handleCreateInvitation(ctx);
    }
    if (url.pathname === "/api/invitations/lookup" && request.method === "GET") {
      return handleLookupInvitation(ctx);
    }
    if (url.pathname === "/api/invitations/accept" && request.method === "POST") {
      return handleAcceptInvitation(ctx);
    }
    const idMatch = INVITATION_ID_RE.exec(url.pathname);
    if (idMatch) {
      const invitationId = idMatch[1] as string;
      const subAction = idMatch[2];
      if (!subAction && request.method === "GET") {
        return handleGetInvitation(ctx, invitationId);
      }
      if (subAction === "revoke" && request.method === "POST") {
        return handleRevokeInvitation(ctx, invitationId);
      }
      if (subAction === "resend" && request.method === "POST") {
        return handleResendInvitation(ctx, invitationId);
      }
    }

    // Universities CRUD (UNI-11)
    if (url.pathname === "/api/universities" && request.method === "GET") {
      return handleListUniversities(ctx);
    }
    if (url.pathname === "/api/universities" && request.method === "POST") {
      return handleCreateUniversity(ctx);
    }
    const uniMatch = UNIVERSITY_ID_RE.exec(url.pathname);
    if (uniMatch) {
      const universityId = uniMatch[1] as string;
      if (request.method === "GET") {
        return handleGetUniversity(ctx, universityId);
      }
      if (request.method === "PATCH") {
        return handleUpdateUniversity(ctx, universityId);
      }
    }

    // Users management (UNI-11)
    if (url.pathname === "/api/users" && request.method === "GET") {
      return handleListUsers(ctx);
    }
    const userMatch = USER_ID_RE.exec(url.pathname);
    if (userMatch) {
      const userId = userMatch[1] as string;
      const sub = userMatch[2];
      if (!sub && request.method === "GET") {
        return handleGetUser(ctx, userId);
      }
      if (!sub && request.method === "PATCH") {
        return handleUpdateUser(ctx, userId);
      }
      if (!sub && request.method === "DELETE") {
        return handleDeleteUser(ctx, userId);
      }
      if (sub === "role" && request.method === "PATCH") {
        return handleUpdateUserRole(ctx, userId);
      }
      if (sub === "status" && request.method === "PATCH") {
        return handleUpdateUserStatus(ctx, userId);
      }
    }

    // Departments CRUD (UNI-12)
    if (url.pathname === "/api/departments" && request.method === "GET") {
      return handleListDepartments(ctx);
    }
    if (url.pathname === "/api/departments" && request.method === "POST") {
      return handleCreateDepartment(ctx);
    }
    const deptMatch = DEPARTMENT_ID_RE.exec(url.pathname);
    if (deptMatch) {
      const departmentId = deptMatch[1] as string;
      if (request.method === "GET") {
        return handleGetDepartment(ctx, departmentId);
      }
      if (request.method === "PATCH") {
        return handleUpdateDepartment(ctx, departmentId);
      }
      if (request.method === "DELETE") {
        return handleDeleteDepartment(ctx, departmentId);
      }
    }

    // Courses CRUD + assignments (UNI-12). Match the assignments routes first
    // so the bare-id regex doesn't try to swallow `/assignments` paths.
    if (url.pathname === "/api/courses" && request.method === "GET") {
      return handleListCourses(ctx);
    }
    if (url.pathname === "/api/courses" && request.method === "POST") {
      return handleCreateCourse(ctx);
    }
    const assignmentMatch = COURSE_ASSIGNMENT_RE.exec(url.pathname);
    if (assignmentMatch) {
      const courseId = assignmentMatch[1] as string;
      const assignmentId = assignmentMatch[2];
      if (!assignmentId && request.method === "GET") {
        return handleListCourseAssignments(ctx, courseId);
      }
      if (!assignmentId && request.method === "POST") {
        return handleCreateCourseAssignment(ctx, courseId);
      }
      if (assignmentId && request.method === "DELETE") {
        return handleDeleteCourseAssignment(ctx, courseId, assignmentId);
      }
    }
    // Per-course assessments + grades (UNI-30). Match before the bare
    // course-id regex so `/courses/:id/assessments` doesn't get swallowed.
    const courseAssessmentsMatch = COURSE_ASSESSMENTS_RE.exec(url.pathname);
    if (courseAssessmentsMatch) {
      const courseId = courseAssessmentsMatch[1] as string;
      if (request.method === "GET") {
        return handleListAssessments(ctx, courseId);
      }
      if (request.method === "POST") {
        return handleCreateAssessment(ctx, courseId);
      }
    }
    const courseGradesMatch = COURSE_GRADES_RE.exec(url.pathname);
    if (courseGradesMatch) {
      const courseId = courseGradesMatch[1] as string;
      if (request.method === "GET") {
        return handleListCourseGrades(ctx, courseId);
      }
    }
    // Faculty course analytics (UNI-31). Both routes are matched before the
    // bare-id course regex so `/courses/:id/analytics/...` doesn't get
    // swallowed by `GET /api/courses/:id`.
    const courseAnalyticsAssessmentMatch =
      COURSE_ANALYTICS_ASSESSMENT_RE.exec(url.pathname);
    if (courseAnalyticsAssessmentMatch && request.method === "GET") {
      return handleAssessmentAnalyticsSummary(
        ctx,
        courseAnalyticsAssessmentMatch[1] as string,
        courseAnalyticsAssessmentMatch[2] as string,
      );
    }
    const courseAnalyticsSummaryMatch =
      COURSE_ANALYTICS_SUMMARY_RE.exec(url.pathname);
    if (courseAnalyticsSummaryMatch && request.method === "GET") {
      return handleCourseAnalyticsSummary(
        ctx,
        courseAnalyticsSummaryMatch[1] as string,
      );
    }
    const courseMatch = COURSE_ID_RE.exec(url.pathname);
    if (courseMatch) {
      const courseId = courseMatch[1] as string;
      if (request.method === "GET") {
        return handleGetCourse(ctx, courseId);
      }
      if (request.method === "PATCH") {
        return handleUpdateCourse(ctx, courseId);
      }
      if (request.method === "DELETE") {
        return handleDeleteCourse(ctx, courseId);
      }
    }

    // Assessments + grades by id (UNI-30).
    const assessmentIdMatch = ASSESSMENT_ID_RE.exec(url.pathname);
    if (assessmentIdMatch) {
      const assessmentId = assessmentIdMatch[1] as string;
      if (request.method === "PATCH") {
        return handleUpdateAssessment(ctx, assessmentId);
      }
      if (request.method === "DELETE") {
        return handleDeleteAssessment(ctx, assessmentId);
      }
    }
    if (url.pathname === "/api/grades" && request.method === "POST") {
      return handleCreateGrade(ctx);
    }
    const gradeIdMatch = GRADE_ID_RE.exec(url.pathname);
    if (gradeIdMatch && request.method === "PATCH") {
      return handleUpdateGrade(ctx, gradeIdMatch[1] as string);
    }

    // Students directory (UNI-13). Static `/me*` paths first so the id regex
    // doesn't try to interpret `me` as a UUID.
    if (url.pathname === "/api/students" && request.method === "GET") {
      return handleListStudents(ctx);
    }
    if (url.pathname === "/api/students/me" && request.method === "GET") {
      return handleGetMyStudent(ctx);
    }
    if (
      url.pathname === "/api/students/me/courses" &&
      request.method === "GET"
    ) {
      return handleListMyStudentCourses(ctx);
    }
    // Student grades (UNI-30). Match before the bare student-id regex so
    // `/students/:id/grades` doesn't get swallowed.
    const studentGradesMatch = STUDENT_GRADES_RE.exec(url.pathname);
    if (studentGradesMatch && request.method === "GET") {
      return handleListStudentGrades(ctx, studentGradesMatch[1] as string);
    }
    // FERPA directory-info opt-out PATCH (UNI-32). Same precedence rule.
    const studentDirectoryInfoMatch = STUDENT_DIRECTORY_INFO_RE.exec(
      url.pathname,
    );
    if (studentDirectoryInfoMatch && request.method === "PATCH") {
      return handleUpdateStudentDirectoryInfo(
        ctx,
        studentDirectoryInfoMatch[1] as string,
      );
    }
    const studentMatch = STUDENT_ID_RE.exec(url.pathname);
    if (studentMatch && request.method === "GET") {
      return handleGetStudent(ctx, studentMatch[1] as string);
    }

    // Faculty directory (UNI-13).
    if (url.pathname === "/api/faculty" && request.method === "GET") {
      return handleListFaculty(ctx);
    }
    if (url.pathname === "/api/faculty/me" && request.method === "GET") {
      return handleGetMyFaculty(ctx);
    }
    const facultyMatch = FACULTY_ID_RE.exec(url.pathname);
    if (facultyMatch && request.method === "GET") {
      return handleGetFaculty(ctx, facultyMatch[1] as string);
    }

    // Teachers directory + nested courses/students (UNI-13).
    if (url.pathname === "/api/teachers" && request.method === "GET") {
      return handleListTeachers(ctx);
    }
    if (url.pathname === "/api/teachers/me" && request.method === "GET") {
      return handleGetMyTeacher(ctx);
    }
    if (url.pathname === "/api/teachers/me/courses" && request.method === "GET") {
      return handleListMyTeacherCourses(ctx);
    }
    if (url.pathname === "/api/teachers/me/students" && request.method === "GET") {
      return handleListMyTeacherStudents(ctx);
    }
    const teacherMatch = TEACHER_ID_RE.exec(url.pathname);
    if (teacherMatch && request.method === "GET") {
      const teacherId = teacherMatch[1] as string;
      const sub = teacherMatch[2];
      if (!sub) return handleGetTeacher(ctx, teacherId);
      if (sub === "courses") return handleListTeacherCourses(ctx, teacherId);
      if (sub === "students") return handleListTeacherStudents(ctx, teacherId);
    }

    // Teacher-assistants directory + nested courses (UNI-13).
    if (
      url.pathname === "/api/teacher-assistants" &&
      request.method === "GET"
    ) {
      return handleListTeacherAssistants(ctx);
    }
    if (
      url.pathname === "/api/teacher-assistants/me" &&
      request.method === "GET"
    ) {
      return handleGetMyTeacherAssistant(ctx);
    }
    if (
      url.pathname === "/api/teacher-assistants/me/courses" &&
      request.method === "GET"
    ) {
      return handleListMyTeacherAssistantCourses(ctx);
    }
    const taMatch = TEACHER_ASSISTANT_ID_RE.exec(url.pathname);
    if (taMatch && request.method === "GET") {
      const taId = taMatch[1] as string;
      const sub = taMatch[2];
      if (!sub) return handleGetTeacherAssistant(ctx, taId);
      if (sub === "courses") return handleListTeacherAssistantCourses(ctx, taId);
    }

    return errorResponse(404, "not_found", "The requested resource was not found.");
}
