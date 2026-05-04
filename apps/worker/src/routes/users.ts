// Users management endpoints (epic UNI-1 §9, §17, §28).
//
//   GET   /api/users               list (search + role/status filter, scoped)
//   GET   /api/users/:id           detail (scoped)
//   PATCH /api/users/:id           profile (name)                → user.updated
//   PATCH /api/users/:id/role      role change with escalation guard
//                                                                 → user.role_changed
//   PATCH /api/users/:id/status    activate/deactivate/suspend
//                                  + sendAccountStatusChangedEmail
//                                                                 → user.status_changed
//
// RBAC source of truth lives here. Privilege escalation rules:
//   - Only super_admin and university_admin may manage users.
//   - university_admin is scoped to users in their own university.
//   - university_admin may NOT manage another super_admin or university_admin
//     (sibling/peer escalation), and may NOT promote anyone to those roles.
//
// All forbidden writes still emit an audit row so attempts are visible to
// security reviews — see the explicit `user.role_changed` / `user.status_changed`
// "denied" entries below.

import {
  ROLE_LABELS,
  canAssignRole,
  canManageTargetUser,
  canManageUsers,
  updateUserProfileInputSchema,
  updateUserRoleInputSchema,
  updateUserStatusInputSchema,
  type Role,
  type User,
  type UserListItem,
  type UserStatus,
  type UserStatusChangeResult,
} from "@university-hub/shared";

import { revokeAllSessionsForUser, type UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import {
  sendAccountStatusChangedEmail,
  type SendResult,
} from "../mail/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type UserListRow = Row & {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  university_id: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  university_name: string | null;
};

const USER_LIST_SQL = `
  SELECT u.id, u.email, u.name, u.role, u.status, u.university_id,
         u.last_sign_in_at, u.created_at, u.updated_at,
         un.name AS university_name
    FROM users u
    LEFT JOIN universities un ON un.id = u.university_id
`;

function toUser(row: UserListRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    university_id: row.university_id,
    last_sign_in_at: row.last_sign_in_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toUserListItem(row: UserListRow): UserListItem {
  return { ...toUser(row), university_name: row.university_name };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Whether `actor` is allowed to even read the target user. */
function inReadScope(actor: UserRow, target: { university_id: string | null }): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") {
    return target.university_id !== null && target.university_id === actor.university_id;
  }
  return false;
}

/**
 * Whether `actor` is allowed to *manage* (write to) the target user. Combines
 * read scope with the role-based privilege rules in @university-hub/shared.
 */
function inWriteScope(actor: UserRow, target: { university_id: string | null; role: Role }): boolean {
  if (!inReadScope(actor, target)) return false;
  return canManageTargetUser(actor.role, target.role);
}

async function loadUserRow(
  db: D1Database,
  id: string,
): Promise<UserListRow | null> {
  return queryFirst<UserListRow>(
    db,
    `${USER_LIST_SQL} WHERE u.id = ? LIMIT 1`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

export async function handleListUsers(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canManageUsers(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the user directory.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "university_admin") {
    where.push("u.university_id = ?");
    params.push(actor.university_id);
  } else {
    // super_admin may filter by ?university_id=…
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("u.university_id = ?");
      params.push(universityId);
    }
  }

  const role = ctx.url.searchParams.get("role");
  if (role) {
    where.push("u.role = ?");
    params.push(role);
  }
  const status = ctx.url.searchParams.get("status");
  if (status) {
    where.push("u.status = ?");
    params.push(status);
  }
  const q = ctx.url.searchParams.get("q")?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push("(LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ?)");
    params.push(like, like);
  }

  const sql =
    USER_LIST_SQL +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY u.created_at DESC LIMIT 200";

  const rows = await queryAll<UserListRow>(ctx.env.DB, sql, params);
  return jsonOk(rows.map(toUserListItem));
}

// ---------------------------------------------------------------------------
// GET /api/users/:id
// ---------------------------------------------------------------------------

export async function handleGetUser(
  ctx: RequestContext,
  userId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canManageUsers(actor.role)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view users.",
    );
  }

  const row = await loadUserRow(ctx.env.DB, userId);
  // 404 (not 403) when out of scope: don't reveal existence to other tenants.
  if (!row || !inReadScope(actor, row)) {
    return errorResponse(404, "not_found", "User not found.");
  }
  return jsonOk(toUserListItem(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/users/:id           — basic profile (name)
// ---------------------------------------------------------------------------

export async function handleUpdateUser(
  ctx: RequestContext,
  userId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canManageUsers(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to update users.");
  }

  const row = await loadUserRow(ctx.env.DB, userId);
  if (!row || !inReadScope(actor, row)) {
    return errorResponse(404, "not_found", "User not found.");
  }
  if (!inWriteScope(actor, row)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to modify this user.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateUserProfileInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid user payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const changed: Record<string, unknown> = {};
  if (parsed.data.name !== undefined && parsed.data.name !== row.name) {
    changed.name = parsed.data.name;
  }
  if (Object.keys(changed).length === 0) {
    return jsonOk(toUserListItem(row));
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
    [parsed.data.name, now, userId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "user.updated",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "user",
    entityId: userId,
    metadata: { changed },
  });

  const refreshed = await loadUserRow(ctx.env.DB, userId);
  return jsonOk(refreshed ? toUserListItem(refreshed) : toUserListItem(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/role
// ---------------------------------------------------------------------------

export async function handleUpdateUserRole(
  ctx: RequestContext,
  userId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canManageUsers(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to change roles.");
  }

  const row = await loadUserRow(ctx.env.DB, userId);
  if (!row || !inReadScope(actor, row)) {
    return errorResponse(404, "not_found", "User not found.");
  }

  const raw = await readJson(ctx.request);
  const parsed = updateUserRoleInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid role payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const newRole = parsed.data.role;

  // No self-demotion: the only super_admin shouldn't be able to lock themselves
  // out by accident, and a university_admin shouldn't be able to drop their
  // own admin role mid-session.
  if (actor.id === userId && newRole !== row.role) {
    return errorResponse(
      403,
      "forbidden_self",
      "You cannot change your own role. Ask another admin.",
    );
  }

  // Privilege escalation guards: can the actor manage this *target user*, and
  // can they assign the *new role*? Both must hold.
  const targetOk = inWriteScope(actor, row);
  const newRoleOk = canAssignRole(actor.role, newRole);

  if (!targetOk || !newRoleOk) {
    await writeAuditLog(ctx.env.DB, {
      action: "user.role_changed",
      actorUserId: actor.id,
      universityId: row.university_id,
      entityType: "user",
      entityId: userId,
      metadata: {
        denied: true,
        reason: !targetOk ? "target_out_of_scope" : "role_not_assignable",
        attempted_role: newRole,
        previous_role: row.role,
      },
    });
    return errorResponse(
      403,
      "forbidden",
      `You do not have permission to assign the role "${ROLE_LABELS[newRole]}".`,
    );
  }

  if (newRole === row.role) {
    return jsonOk(toUserListItem(row));
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`,
    [newRole, now, userId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "user.role_changed",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "user",
    entityId: userId,
    metadata: { previous_role: row.role, new_role: newRole },
  });

  // Privilege change → invalidate every existing session for the target so
  // the new role takes effect immediately instead of waiting for the cookie
  // to expire (UNI-26). Applies to promotions and demotions alike.
  await revokeUserSessionsAfterPrivilegeChange(ctx, {
    targetUserId: userId,
    targetUniversityId: row.university_id,
    actorId: actor.id,
    reason: "role_change",
    metadata: { previous_role: row.role, new_role: newRole },
  });

  const refreshed = await loadUserRow(ctx.env.DB, userId);
  return jsonOk(refreshed ? toUserListItem(refreshed) : { ...toUserListItem(row), role: newRole });
}

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/status
// ---------------------------------------------------------------------------

export async function handleUpdateUserStatus(
  ctx: RequestContext,
  userId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (!canManageUsers(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to change status.");
  }

  const row = await loadUserRow(ctx.env.DB, userId);
  if (!row || !inReadScope(actor, row)) {
    return errorResponse(404, "not_found", "User not found.");
  }

  const raw = await readJson(ctx.request);
  const parsed = updateUserStatusInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid status payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const newStatus = parsed.data.status;

  // No self-deactivation.
  if (actor.id === userId && newStatus !== row.status) {
    return errorResponse(
      403,
      "forbidden_self",
      "You cannot change your own status. Ask another admin.",
    );
  }

  if (!inWriteScope(actor, row)) {
    await writeAuditLog(ctx.env.DB, {
      action: "user.status_changed",
      actorUserId: actor.id,
      universityId: row.university_id,
      entityType: "user",
      entityId: userId,
      metadata: {
        denied: true,
        reason: "target_out_of_scope",
        attempted_status: newStatus,
        previous_status: row.status,
      },
    });
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to change this user's status.",
    );
  }

  if (newStatus === row.status) {
    const body: UserStatusChangeResult = {
      user: toUserListItem(row),
      email_status: "sent",
      email_error: null,
    };
    return jsonOk(body);
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users SET status = ?, updated_at = ? WHERE id = ?`,
    [newStatus, now, userId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "user.status_changed",
    actorUserId: actor.id,
    universityId: row.university_id,
    entityType: "user",
    entityId: userId,
    metadata: { previous_status: row.status, new_status: newStatus },
  });

  // Status change → invalidate every existing session for the target so a
  // suspended/inactive user can't keep operating on a still-warm cookie
  // (UNI-26). The middleware would already 401 on `status !== "active"`,
  // but deleting the rows tightens the loop and lets us emit per-session
  // audit entries.
  await revokeUserSessionsAfterPrivilegeChange(ctx, {
    targetUserId: userId,
    targetUniversityId: row.university_id,
    actorId: actor.id,
    reason: "status_change",
    metadata: { previous_status: row.status, new_status: newStatus },
  });

  // Email the user. Mailgun may be unconfigured in dev/prod (placeholder
  // secrets) — that surfaces as `email_status: failed`, the `email_logs` row
  // is still written by `dispatch()` in mail/index.ts, and the API response
  // simply reports the failure for the admin UI to show.
  const sendResult = await sendAccountStatusChangedEmail(ctx.env, {
    to: row.email,
    userId,
    universityId: row.university_id,
    variables: {
      recipient_name: row.name,
      account_status: newStatus,
    },
  });

  await recordEmailAudit(ctx, sendResult, {
    actorId: actor.id,
    universityId: row.university_id,
    userId,
  });

  const refreshed = await loadUserRow(ctx.env.DB, userId);
  const body: UserStatusChangeResult = {
    user: refreshed ? toUserListItem(refreshed) : { ...toUserListItem(row), status: newStatus },
    email_status: sendResult.ok ? "sent" : "failed",
    email_error: sendResult.ok ? null : describeFailure(sendResult),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface EmailAuditInput {
  actorId: string;
  universityId: string | null;
  userId: string;
}

async function recordEmailAudit(
  ctx: RequestContext,
  send: SendResult,
  input: EmailAuditInput,
): Promise<void> {
  await writeAuditLog(ctx.env.DB, {
    action: send.ok ? "email.sent" : "email.failed",
    actorUserId: input.actorId,
    universityId: input.universityId,
    entityType: "user",
    entityId: input.userId,
    metadata: {
      email_type: "account_status_changed",
      ok: send.ok,
      ...(send.ok ? {} : { reason: send.reason }),
    },
  });
}

function describeFailure(result: Extract<SendResult, { ok: false }>): string {
  return result.detail ? `${result.reason}: ${result.detail}` : result.reason;
}

interface PrivilegeChangeRevokeInput {
  targetUserId: string;
  targetUniversityId: string | null;
  actorId: string;
  reason: "role_change" | "status_change";
  metadata: Record<string, unknown>;
}

/**
 * Drop every active session for `targetUserId` and write per-session
 * `session.revoked` audit rows tagged with `reason`. Best-effort: a write
 * failure is logged but the user's role/status change still goes through
 * — the middleware would 401 the next request anyway and the auditor for
 * this run already wrote the role/status audit row.
 */
async function revokeUserSessionsAfterPrivilegeChange(
  ctx: RequestContext,
  input: PrivilegeChangeRevokeInput,
): Promise<void> {
  try {
    const revokedIds = await revokeAllSessionsForUser(
      ctx.env.DB,
      input.targetUserId,
    );
    for (const sessionId of revokedIds) {
      await writeAuditLog(ctx.env.DB, {
        action: "session.revoked",
        actorUserId: input.actorId,
        universityId: input.targetUniversityId,
        entityType: "session",
        entityId: sessionId,
        metadata: {
          reason: input.reason,
          target_user_id: input.targetUserId,
          ...input.metadata,
        },
      });
    }
  } catch (cause) {
    console.error("session_revoke_after_privilege_change_failed", {
      target_user_id: input.targetUserId,
      reason: input.reason,
      cause,
    });
  }
}
