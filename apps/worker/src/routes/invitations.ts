// Invitation lifecycle endpoints (epic UNI-1 §12, §14, §15, §16, §17).
//
//   POST /api/invitations            create
//   GET  /api/invitations            list (filterable by status)
//   GET  /api/invitations/:id        detail
//   POST /api/invitations/:id/revoke revoke (admin)
//   POST /api/invitations/:id/resend resend (rate-limited)
//   POST /api/invitations/accept     public — exchange token for an account
//
// RBAC source of truth lives here; the frontend uses the same `rolesInvitableBy`
// helper for UI affordances but the backend re-checks every call. University
// scoping: super_admin sees / acts on everything; university_admin is scoped
// to their own university (and may not invite super_admins).

import {
  ROLE_LABELS,
  acceptInvitationInputSchema,
  canInvite,
  createInvitationInputSchema,
  rolesInvitableBy,
  type Invitation,
  type InvitationAcceptResult,
  type InvitationCreateResult,
  type InvitationListItem,
  type InvitationLookupResult,
  type InvitationStatus,
  INVITATION_TTL_MS,
} from "@university-hub/shared";

import { hashPassword } from "../auth/password.js";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "../auth/invitation-token.js";
import { createSession, toSessionUser, type UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import {
  sendInvitationEmail,
  sendInvitationResentEmail,
  sendWelcomeEmail,
  type SendResult,
} from "../mail/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import {
  invitationResendLimit,
  rateLimitedResponse,
  bySession,
} from "../middleware/rate-limit.js";
import { writeAuditLog } from "../services/audit.js";
import { buildSessionSetCookie } from "../utils/cookies.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type InvitationRow = Row & {
  id: string;
  email: string;
  role: Invitation["role"];
  status: InvitationStatus;
  token_hash: string;
  university_id: string | null;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

type InvitationListRow = InvitationRow & {
  inviter_name: string | null;
  university_name: string | null;
  last_email_status: "sent" | "failed" | "pending" | null;
  last_email_sent_at: string | null;
  last_email_error: string | null;
};

const INVITATION_LIST_SQL = `
  SELECT i.id, i.email, i.role, i.status, i.token_hash,
         i.university_id, i.invited_by, i.expires_at, i.accepted_at,
         i.created_at,
         u.name AS inviter_name,
         un.name AS university_name,
         le.status     AS last_email_status,
         le.created_at AS last_email_sent_at,
         le.error      AS last_email_error
    FROM invitations i
    LEFT JOIN users u         ON u.id = i.invited_by
    LEFT JOIN universities un ON un.id = i.university_id
    LEFT JOIN (
      SELECT el.related_entity_id,
             el.status,
             el.created_at,
             el.error
        FROM email_logs el
        JOIN (
          SELECT related_entity_id, MAX(created_at) AS max_created
            FROM email_logs
           WHERE related_entity_type = 'invitation'
           GROUP BY related_entity_id
        ) latest
          ON latest.related_entity_id = el.related_entity_id
         AND latest.max_created       = el.created_at
       WHERE el.related_entity_type = 'invitation'
    ) le ON le.related_entity_id = i.id
`;

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    university_id: row.university_id,
    invited_by: row.invited_by,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
  };
}

function toInvitationListItem(row: InvitationListRow): InvitationListItem {
  return {
    ...toInvitation(row),
    invited_by_name: row.inviter_name,
    university_name: row.university_name,
    last_email_status: row.last_email_status,
    last_email_sent_at: row.last_email_sent_at,
    last_email_error: row.last_email_error,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Normalize the on-disk status: `pending` rows past `expires_at` read as `expired`. */
function effectiveStatus(row: InvitationRow): InvitationStatus {
  if (row.status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
    return "expired";
  }
  return row.status;
}

function mapInvitationStatus(row: InvitationRow): Invitation {
  return { ...toInvitation(row), status: effectiveStatus(row) };
}

function mapInvitationListItem(row: InvitationListRow): InvitationListItem {
  return { ...toInvitationListItem(row), status: effectiveStatus(row) };
}

// ---------------------------------------------------------------------------
// POST /api/invitations
// ---------------------------------------------------------------------------

export async function handleCreateInvitation(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canInvite(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to create invitations.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = createInvitationInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid invitation request.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, role } = parsed.data;
  const targetUniversityId = resolveTargetUniversity(actor, parsed.data.university_id ?? null);
  if (targetUniversityId === "forbidden") {
    return errorResponse(
      403,
      "forbidden",
      "You can only invite users into your own university.",
    );
  }

  if (!rolesInvitableBy(actor.role).includes(role)) {
    return errorResponse(
      403,
      "forbidden_role",
      `You cannot invite users with the role "${ROLE_LABELS[role]}".`,
    );
  }

  // Reject if there is already an account on that email.
  const existingUser = await queryFirst(
    ctx.env.DB,
    `SELECT id FROM users WHERE email = ? LIMIT 1`,
    [email],
  );
  if (existingUser) {
    return errorResponse(
      409,
      "user_exists",
      "An account already exists for that email address.",
    );
  }

  // Reject if there is already a pending invitation for that email — admin
  // should resend the existing one rather than creating a duplicate.
  const dupe = await queryFirst<InvitationRow>(
    ctx.env.DB,
    `SELECT id, expires_at, status, email, role, token_hash, university_id,
            invited_by, accepted_at, created_at
       FROM invitations
      WHERE email = ? AND status = 'pending'
      LIMIT 1`,
    [email],
  );
  if (dupe && Date.parse(dupe.expires_at) > Date.now()) {
    return errorResponse(
      409,
      "invitation_pending",
      "A pending invitation already exists for that email. Resend it from the invitations list.",
    );
  }

  const id = crypto.randomUUID();
  const token = generateInvitationToken();
  const tokenHash = await hashInvitationToken(token);
  const expiresAt = computeExpiry(parsed.data.expires_at);

  await execute(
    ctx.env.DB,
    `INSERT INTO invitations
       (id, email, role, status, token_hash, university_id, invited_by, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      id,
      email,
      role,
      tokenHash,
      targetUniversityId,
      actor.id,
      expiresAt.toISOString(),
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "invitation.created",
    actorUserId: actor.id,
    universityId: targetUniversityId,
    entityType: "invitation",
    entityId: id,
    metadata: { email, role },
  });

  const universityName = await fetchUniversityName(ctx.env.DB, targetUniversityId);
  const acceptUrl = buildAcceptUrl(ctx.env.APP_BASE_URL, token);

  const sendResult = await sendInvitationEmail(ctx.env, {
    to: email,
    invitationId: id,
    universityId: targetUniversityId,
    variables: {
      recipient_name: email,
      invited_by_name: actor.name,
      university_name: universityName ?? "",
      invitation_url: acceptUrl,
      invitation_expires_at: expiresAt.toISOString(),
      role: ROLE_LABELS[role],
    },
  });

  await recordEmailAudit(ctx, sendResult, {
    action: sendResult.ok ? "email.sent" : "invitation.email_failed",
    actorId: actor.id,
    universityId: targetUniversityId,
    invitationId: id,
    emailType: "invitation",
  });

  // Refetch so we return the freshly inserted row in the same shape `GET` uses.
  const row = await queryFirst<InvitationRow>(
    ctx.env.DB,
    `SELECT id, email, role, status, token_hash, university_id, invited_by,
            expires_at, accepted_at, created_at
       FROM invitations WHERE id = ?`,
    [id],
  );

  const invitation = row ? mapInvitationStatus(row) : null;
  if (!invitation) {
    return errorResponse(500, "create_failed", "Could not create invitation.");
  }

  const body: InvitationCreateResult = {
    invitation,
    email_status: sendResult.ok ? "sent" : "failed",
    email_error: sendResult.ok ? null : describeFailure(sendResult),
  };
  return jsonOk(body, { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/invitations
// ---------------------------------------------------------------------------

export async function handleListInvitations(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!canInvite(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view invitations.",
    );
  }

  const statusFilter = ctx.url.searchParams.get("status");
  const where: string[] = [];
  const params: unknown[] = [];
  if (actor.role === "university_admin") {
    where.push("i.university_id = ?");
    params.push(actor.university_id);
  }
  if (statusFilter && ["pending", "accepted", "expired", "revoked"].includes(statusFilter)) {
    if (statusFilter === "expired") {
      // pending past expiry OR explicitly stamped expired
      where.push("((i.status = 'pending' AND i.expires_at <= ?) OR i.status = 'expired')");
      params.push(new Date().toISOString());
    } else if (statusFilter === "pending") {
      where.push("i.status = 'pending' AND i.expires_at > ?");
      params.push(new Date().toISOString());
    } else {
      where.push("i.status = ?");
      params.push(statusFilter);
    }
  }
  const sql =
    INVITATION_LIST_SQL +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY i.created_at DESC LIMIT 200";

  const rows = await queryAll<InvitationListRow>(ctx.env.DB, sql, params);
  const items = rows.map(mapInvitationListItem);
  return jsonOk(items);
}

// ---------------------------------------------------------------------------
// GET /api/invitations/:id
// ---------------------------------------------------------------------------

export async function handleGetInvitation(
  ctx: RequestContext,
  invitationId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!canInvite(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to view invitations.");
  }

  const row = await queryFirst<InvitationListRow>(
    ctx.env.DB,
    INVITATION_LIST_SQL + " WHERE i.id = ? LIMIT 1",
    [invitationId],
  );
  if (!row) return errorResponse(404, "not_found", "Invitation not found.");
  if (!isWithinScope(actor, row.university_id)) {
    return errorResponse(404, "not_found", "Invitation not found.");
  }

  return jsonOk(mapInvitationListItem(row));
}

// ---------------------------------------------------------------------------
// POST /api/invitations/:id/revoke
// ---------------------------------------------------------------------------

export async function handleRevokeInvitation(
  ctx: RequestContext,
  invitationId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!canInvite(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to revoke invitations.");
  }

  const row = await loadInvitationRow(ctx.env.DB, invitationId);
  if (!row) return errorResponse(404, "not_found", "Invitation not found.");
  if (!isWithinScope(actor, row.university_id)) {
    return errorResponse(404, "not_found", "Invitation not found.");
  }

  // Only pending (or pending-but-expired) invitations are revocable.
  if (row.status !== "pending") {
    return errorResponse(
      409,
      "invalid_state",
      `Invitation is already ${row.status} and cannot be revoked.`,
    );
  }

  await execute(
    ctx.env.DB,
    `UPDATE invitations SET status = 'revoked' WHERE id = ?`,
    [invitationId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "invitation.revoked",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "invitation",
    entityId: invitationId,
    metadata: { email: row.email },
  });

  const refreshed = await queryFirst<InvitationListRow>(
    ctx.env.DB,
    INVITATION_LIST_SQL + " WHERE i.id = ? LIMIT 1",
    [invitationId],
  );
  return jsonOk(refreshed ? mapInvitationListItem(refreshed) : null);
}

// ---------------------------------------------------------------------------
// POST /api/invitations/:id/resend
// ---------------------------------------------------------------------------

export async function handleResendInvitation(
  ctx: RequestContext,
  invitationId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!canInvite(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to resend invitations.");
  }

  const row = await loadInvitationRow(ctx.env.DB, invitationId);
  if (!row) return errorResponse(404, "not_found", "Invitation not found.");
  if (!isWithinScope(actor, row.university_id)) {
    return errorResponse(404, "not_found", "Invitation not found.");
  }

  if (row.status !== "pending") {
    return errorResponse(
      409,
      "invalid_state",
      `Invitation is ${row.status} and cannot be resent. Create a new invitation instead.`,
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return errorResponse(
      409,
      "invitation_expired",
      "Invitation has expired. Create a new invitation instead.",
    );
  }

  // Rate limit per invitation id (UNI-25). The shared rate-limit middleware
  // handles the bookkeeping; previously this counted email_logs rows, which
  // worked but was awkward to make configurable. Default: 3 per invitation
  // per hour.
  const resendOutcome = await bySession(
    ctx.env,
    "invitation.resend",
    invitationId,
    invitationResendLimit(ctx.env),
  );
  if (!resendOutcome.allowed) {
    return rateLimitedResponse(
      resendOutcome,
      "Too many resends for this invitation. Please wait before trying again.",
    );
  }

  // Resend uses the existing token: we never stored the raw token, so we
  // mint a fresh one and update the stored hash. The previous link from the
  // first email becomes invalid, which is the desired behavior — the latest
  // email is the only valid one.
  const newToken = generateInvitationToken();
  const newHash = await hashInvitationToken(newToken);
  await execute(
    ctx.env.DB,
    `UPDATE invitations SET token_hash = ? WHERE id = ?`,
    [newHash, invitationId],
  );

  const universityName = await fetchUniversityName(ctx.env.DB, row.university_id);
  const acceptUrl = buildAcceptUrl(ctx.env.APP_BASE_URL, newToken);

  const sendResult = await sendInvitationResentEmail(ctx.env, {
    to: row.email,
    invitationId,
    universityId: row.university_id,
    variables: {
      recipient_name: row.email,
      invited_by_name: actor.name,
      university_name: universityName ?? "",
      invitation_url: acceptUrl,
      invitation_expires_at: row.expires_at,
      role: ROLE_LABELS[row.role],
    },
  });

  await writeAuditLog(ctx.env.DB, {
    action: "invitation.resent",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "invitation",
    entityId: invitationId,
    metadata: { email: row.email, email_status: sendResult.ok ? "sent" : "failed" },
  });
  await recordEmailAudit(ctx, sendResult, {
    action: sendResult.ok ? "email.sent" : "invitation.email_failed",
    actorId: actor.id,
    universityId: row.university_id,
    invitationId,
    emailType: "invitation_resend",
  });

  const refreshed = await queryFirst<InvitationListRow>(
    ctx.env.DB,
    INVITATION_LIST_SQL + " WHERE i.id = ? LIMIT 1",
    [invitationId],
  );
  const body: InvitationCreateResult = {
    invitation: refreshed ? mapInvitationListItem(refreshed) : mapInvitationStatus(row),
    email_status: sendResult.ok ? "sent" : "failed",
    email_error: sendResult.ok ? null : describeFailure(sendResult),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// GET /api/invitations/lookup?token=…   (public — used by the accept page)
// ---------------------------------------------------------------------------

export async function handleLookupInvitation(ctx: RequestContext): Promise<Response> {
  const token = ctx.url.searchParams.get("token") ?? "";
  if (!token) {
    const result: InvitationLookupResult = { status: "invalid" };
    return jsonOk(result);
  }
  const tokenHash = await hashInvitationToken(token);
  const row = await queryFirst<InvitationRow & { university_name: string | null }>(
    ctx.env.DB,
    `SELECT i.id, i.email, i.role, i.status, i.token_hash, i.university_id,
            i.invited_by, i.expires_at, i.accepted_at, i.created_at,
            un.name AS university_name
       FROM invitations i
       LEFT JOIN universities un ON un.id = i.university_id
      WHERE i.token_hash = ?
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) {
    const result: InvitationLookupResult = { status: "invalid" };
    return jsonOk(result);
  }
  const status = effectiveStatus(row);
  if (status === "accepted") return jsonOk({ status: "accepted" } satisfies InvitationLookupResult);
  if (status === "revoked") return jsonOk({ status: "revoked" } satisfies InvitationLookupResult);
  if (status === "expired") return jsonOk({ status: "expired" } satisfies InvitationLookupResult);

  const result: InvitationLookupResult = {
    status: "valid",
    email: row.email,
    role: row.role,
    university_id: row.university_id,
    university_name: row.university_name,
    expires_at: row.expires_at,
  };
  return jsonOk(result);
}

// ---------------------------------------------------------------------------
// POST /api/invitations/accept   (public)
// ---------------------------------------------------------------------------

export async function handleAcceptInvitation(ctx: RequestContext): Promise<Response> {
  const raw = await readJson(ctx.request);
  const parsed = acceptInvitationInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Please check the form and try again.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const { token, email, name, password } = parsed.data;

  const tokenHash = await hashInvitationToken(token);
  const row = await queryFirst<InvitationRow>(
    ctx.env.DB,
    `SELECT id, email, role, status, token_hash, university_id, invited_by,
            expires_at, accepted_at, created_at
       FROM invitations
      WHERE token_hash = ?
      LIMIT 1`,
    [tokenHash],
  );

  if (!row) {
    return errorResponse(
      400,
      "invalid_token",
      "This invitation link is no longer valid. Please request a new invitation.",
    );
  }

  const status = effectiveStatus(row);
  if (status === "accepted") {
    return errorResponse(
      409,
      "already_accepted",
      "This invitation has already been accepted. Please sign in.",
    );
  }
  if (status === "revoked") {
    return errorResponse(
      409,
      "revoked",
      "This invitation has been revoked. Please request a new one.",
    );
  }
  if (status === "expired") {
    return errorResponse(
      410,
      "expired",
      "This invitation has expired. Please request a new one.",
    );
  }

  if (row.email !== email) {
    return errorResponse(
      400,
      "email_mismatch",
      "The email you entered doesn't match the invitation. Please use the email the invitation was sent to.",
    );
  }

  // If somebody signed up another way in the meantime, refuse.
  const existingUser = await queryFirst<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM users WHERE email = ? LIMIT 1`,
    [row.email],
  );
  if (existingUser) {
    return errorResponse(
      409,
      "user_exists",
      "An account already exists for that email address. Please sign in.",
    );
  }

  // Create the user, mark the invitation accepted. D1 batch isn't a true
  // transaction (per db/index.ts) but the worst case here is a created user
  // with a still-pending invitation, which the next accept would catch via
  // the `user_exists` check above.
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  // Resolve the ToS / Privacy versions in force for this customer so we can
  // stamp `terms_accepted_version` at create-time (UNI-34). Falls back to
  // version 1 / the seeded boilerplate when no row exists yet.
  const termsVersion = await currentLegalVersion(
    ctx.env.DB,
    row.university_id,
    "terms",
  );
  const privacyVersion = await currentLegalVersion(
    ctx.env.DB,
    row.university_id,
    "privacy",
  );

  await execute(
    ctx.env.DB,
    `INSERT INTO users (id, email, password_hash, name, role, status, university_id,
                        last_sign_in_at, created_at, updated_at,
                        terms_accepted_at, terms_accepted_version)
     VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`,
    [
      userId,
      row.email,
      passwordHash,
      name,
      row.role,
      row.university_id,
      now,
      now,
      now,
      termsVersion,
    ],
  );
  await execute(
    ctx.env.DB,
    `UPDATE invitations SET status = 'accepted', accepted_at = ? WHERE id = ?`,
    [now, row.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "invitation.accepted",
    actorUserId: userId,
    universityId: row.university_id,
    entityType: "invitation",
    entityId: row.id,
    metadata: { email: row.email, role: row.role },
  });
  await writeAuditLog(ctx.env.DB, {
    action: "user.created",
    actorUserId: userId,
    universityId: row.university_id,
    entityType: "user",
    entityId: userId,
    metadata: { source: "invitation_accept", role: row.role },
  });
  await writeAuditLog(ctx.env.DB, {
    action: "legal.terms_accepted",
    actorUserId: userId,
    universityId: row.university_id,
    entityType: "user",
    entityId: userId,
    metadata: {
      terms_version: termsVersion,
      privacy_version: privacyVersion,
      source: "invitation_accept",
    },
  });

  // Welcome email — failure is non-blocking (logged in `email_logs`).
  const universityName = await fetchUniversityName(ctx.env.DB, row.university_id);
  const welcomeResult = await sendWelcomeEmail(ctx.env, {
    to: row.email,
    universityId: row.university_id,
    variables: {
      recipient_name: name,
      university_name: universityName ?? "",
      role: ROLE_LABELS[row.role],
    },
  });
  await recordEmailAudit(ctx, welcomeResult, {
    action: welcomeResult.ok ? "email.sent" : "email.failed",
    actorId: userId,
    universityId: row.university_id,
    invitationId: row.id,
    emailType: "welcome",
  });

  // Auto sign-in: create a session and set the cookie so the user lands on
  // the dashboard already authenticated.
  const userRow = await queryFirst<UserRow>(
    ctx.env.DB,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at
       FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );

  const ipAddress =
    ctx.request.headers.get("cf-connecting-ip") ??
    ctx.request.headers.get("x-forwarded-for") ??
    null;
  const userAgent = ctx.request.headers.get("user-agent");
  const created = await createSession(ctx.env, {
    userId,
    ipAddress,
    userAgent,
  });
  await execute(
    ctx.env.DB,
    `UPDATE users SET last_sign_in_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, userId],
  );

  const cookieName = ctx.env.SESSION_COOKIE_NAME || "university_hub_session";
  const setCookie = buildSessionSetCookie(ctx.env, {
    name: cookieName,
    value: created.token,
    expires: created.expiresAt,
  });

  const body: InvitationAcceptResult = {
    user_id: userId,
    email: row.email,
    role: row.role,
  };
  // `user` shape is the same as /api/auth/me so the frontend can hydrate
  // its AuthContext from the response if it wants.
  const headers: HeadersInit = userRow ? { "set-cookie": setCookie } : {};
  return jsonOk({ ...body, user: userRow ? toSessionUser(userRow) : null }, {
    status: 201,
    headers,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveTargetUniversity(
  actor: UserRow,
  requested: string | null,
): string | null | "forbidden" {
  if (actor.role === "super_admin") {
    return requested ?? null;
  }
  // university_admin: ignore any client-supplied override outside their own
  // scope. Either the request omits it (use the actor's university) or it
  // matches the actor's university; anything else is forbidden.
  if (!requested) return actor.university_id;
  if (requested !== actor.university_id) return "forbidden";
  return requested;
}

function isWithinScope(actor: UserRow, universityId: string | null): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") return universityId === actor.university_id;
  return false;
}

function computeExpiry(override?: string): Date {
  if (override) {
    const parsed = Date.parse(override);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      return new Date(parsed);
    }
  }
  return new Date(Date.now() + INVITATION_TTL_MS);
}

function buildAcceptUrl(baseUrl: string | undefined, rawToken: string): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "") || "http://localhost:5173";
  return `${base}/accept-invitation?token=${encodeURIComponent(rawToken)}`;
}

async function fetchUniversityName(
  db: D1Database,
  universityId: string | null,
): Promise<string | null> {
  if (!universityId) return null;
  const row = await queryFirst<{ name: string }>(
    db,
    `SELECT name FROM universities WHERE id = ? LIMIT 1`,
    [universityId],
  );
  return row?.name ?? null;
}

/**
 * Resolve the ToS / Privacy version in force for a given customer at
 * invitation-accept time (UNI-34). The lookup is `customer override →
 * global default → "1" if neither exists`. Stamping the user's
 * `terms_accepted_version` at create time keeps the in-app gate logic
 * symmetric (same compare regardless of which path created the user).
 */
async function currentLegalVersion(
  db: D1Database,
  universityId: string | null,
  kind: "terms" | "privacy",
): Promise<number> {
  if (universityId) {
    const customer = await queryFirst<{ version: number }>(
      db,
      `SELECT version FROM legal_documents
        WHERE university_id = ? AND kind = ? LIMIT 1`,
      [universityId, kind],
    );
    if (customer) return customer.version;
  }
  const global = await queryFirst<{ version: number }>(
    db,
    `SELECT version FROM legal_documents
      WHERE university_id IS NULL AND kind = ? LIMIT 1`,
    [kind],
  );
  return global?.version ?? 1;
}

async function loadInvitationRow(
  db: D1Database,
  invitationId: string,
): Promise<InvitationRow | null> {
  return queryFirst<InvitationRow>(
    db,
    `SELECT id, email, role, status, token_hash, university_id, invited_by,
            expires_at, accepted_at, created_at
       FROM invitations WHERE id = ? LIMIT 1`,
    [invitationId],
  );
}

interface EmailAuditInput {
  action: "email.sent" | "email.failed" | "invitation.email_failed";
  actorId: string | null;
  universityId: string | null;
  invitationId: string;
  emailType: "invitation" | "invitation_resend" | "welcome";
}

async function recordEmailAudit(
  ctx: RequestContext,
  send: SendResult,
  input: EmailAuditInput,
): Promise<void> {
  await writeAuditLog(ctx.env.DB, {
    action: input.action,
    actorUserId: input.actorId,
    universityId: input.universityId,
    entityType: "invitation",
    entityId: input.invitationId,
    metadata: {
      email_type: input.emailType,
      ok: send.ok,
      ...(send.ok ? {} : { reason: send.reason }),
    },
  });
}

function describeFailure(result: Extract<SendResult, { ok: false }>): string {
  return result.detail ? `${result.reason}: ${result.detail}` : result.reason;
}
