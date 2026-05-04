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
import { errorResponse, jsonOk } from "./utils/responses.js";

export type { Env } from "./env.js";

const INVITATION_ID_RE =
  /^\/api\/invitations\/([0-9a-fA-F-]{36})(?:\/(revoke|resend))?\/?$/;

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

    return errorResponse(404, "not_found", "The requested resource was not found.");
  },
} satisfies ExportedHandler<Env>;
