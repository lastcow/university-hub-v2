import type { HealthResponse } from "@university-hub/shared";

import type { Env } from "./env.js";
import { buildContext } from "./middleware/auth.js";
import { handleListAuditLogs } from "./routes/audit-logs.js";
import { handleMe, handleSignIn, handleSignOut } from "./routes/auth.js";
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
import { handleListEmailLogs } from "./routes/email-logs.js";
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
  handleGetSystemStatus,
  handleUpdateAccountSettings,
  handleUpdateUniversitySettings,
} from "./routes/settings.js";
import {
  handleCreateUniversity,
  handleGetUniversity,
  handleListUniversities,
  handleUpdateUniversity,
} from "./routes/universities.js";
import {
  handleGetUser,
  handleListUsers,
  handleUpdateUser,
  handleUpdateUserRole,
  handleUpdateUserStatus,
} from "./routes/users.js";
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
const STUDENT_ID_RE = /^\/api\/students\/([0-9a-fA-F-]{36})\/?$/;
const FACULTY_ID_RE = /^\/api\/faculty\/([0-9a-fA-F-]{36})\/?$/;
const TEACHER_ID_RE =
  /^\/api\/teachers\/([0-9a-fA-F-]{36})(?:\/(courses|students))?\/?$/;
const TEACHER_ASSISTANT_ID_RE =
  /^\/api\/teacher-assistants\/([0-9a-fA-F-]{36})(?:\/(courses))?\/?$/;

export default {
  async fetch(request, env): Promise<Response> {
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

    const ctx = await buildContext(request, env);

    const response = await routeApi(ctx, request, env, url);
    return withCors(response, env, request);
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

    // Logs admin (UNI-14). Read-only; RBAC + university scoping inside the
    // handlers (super_admin + university_admin for both; staff also reads
    // audit logs but never email logs).
    if (url.pathname === "/api/audit-logs" && request.method === "GET") {
      return handleListAuditLogs(ctx);
    }
    if (url.pathname === "/api/email-logs" && request.method === "GET") {
      return handleListEmailLogs(ctx);
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
