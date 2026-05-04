import type { HealthResponse } from "@university-hub/shared";

import type { Env } from "./env.js";
import { buildContext } from "./middleware/auth.js";
import { handleMe, handleSignIn, handleSignOut } from "./routes/auth.js";
import { handleCreateContactMessage } from "./routes/contact.js";
import { handleDashboardSummary } from "./routes/dashboard.js";
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
import { errorResponse, jsonOk } from "./utils/responses.js";

export type { Env } from "./env.js";

const INVITATION_ID_RE =
  /^\/api\/invitations\/([0-9a-fA-F-]{36})(?:\/(revoke|resend))?\/?$/;
const UNIVERSITY_ID_RE = /^\/api\/universities\/([0-9a-fA-F-]{36})\/?$/;
const USER_ID_RE = /^\/api\/users\/([0-9a-fA-F-]{36})(?:\/(role|status))?\/?$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const ctx = await buildContext(request, env);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const body: HealthResponse = {
        ok: true,
        service: "university-hub-worker",
        timestamp: new Date().toISOString(),
      };
      return jsonOk(body);
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

    if (url.pathname === "/api/dashboard/summary" && request.method === "GET") {
      return handleDashboardSummary(ctx);
    }

    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleCreateContactMessage(ctx);
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

    return errorResponse(404, "not_found", "The requested resource was not found.");
  },
} satisfies ExportedHandler<Env>;
