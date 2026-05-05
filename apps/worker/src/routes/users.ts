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
  deleteUserInputSchema,
  updateUserProfileInputSchema,
  updateUserRoleInputSchema,
  updateUserStatusInputSchema,
  type DeleteUserResult,
  type Role,
  type User,
  type UserListItem,
  type UserStatus,
  type UserStatusChangeResult,
} from "@university-hub/shared";

import { revokeAllSessionsForUser, type UserRow } from "../auth/session.js";
import { batch, execute, queryAll, queryFirst, type Row } from "../db/index.js";
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
  } else if (ctx.url.searchParams.get("include_deleted") !== "true") {
    // Default: hide tombstoned (UNI-61) rows so the directory only shows
    // active accounts. The Settings → Users page surfaces a toggle that
    // sets `?include_deleted=true` for admins who want to inspect the
    // anonymized rows. If the caller already filtered by an explicit
    // status (e.g. the dropdown), we honour that and don't double-filter.
    where.push("u.status != 'deleted'");
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
// DELETE /api/users/:id           — FERPA-aligned anonymization (UNI-61)
// ---------------------------------------------------------------------------

type CountRow = Row & { c: number };

/**
 * Redact an email for the audit row. Keeps the first character of the local
 * part and the first character of the domain so an audit reader can roughly
 * recognize an account without preserving deliverable PII. Examples:
 *
 *   alice@frostburg.edu  → "a***@f***.edu"
 *   short@x.io           → "s***@x***.io"
 *   "a@b.c"              → "a***@b***.c"
 *
 * Always emits the asterisk run so the redacted form looks consistent across
 * lengths; the actual original value is never echoed back.
 */
function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return "***";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0) {
    return `${local[0]}***@${domain[0]}***`;
  }
  return `${local[0]}***@${domain[0]}***${domain.slice(dot)}`;
}

/**
 * Build the deterministic anonymization payload for `users.id`. The numeric
 * suffix mirrors `displayUserName` in @university-hub/shared so the row's
 * stored `name` and the UI's runtime substitution always render the same
 * string (any UI surface that didn't get switched over to `displayUserName`
 * will still show a reasonable label).
 */
function buildAnonymizedUser(id: string): {
  name: string;
  email: string;
  emailLocal: string;
} {
  const compact = id.replace(/-/g, "").toLowerCase();
  const suffix = compact.slice(0, 8);
  return {
    name: `Removed User #${suffix}`,
    email: `removed-${id}@local.invalid`,
    emailLocal: `removed-${id}`,
  };
}

interface DeleteCascadeInput {
  targetId: string;
  targetEmail: string;
  now: string;
}

/**
 * Compose the cascade as a list of prepared-statement specs. The caller
 * runs these via `db.batch(...)` so the whole sequence either commits or
 * rolls back together (Cloudflare D1 batches are SQL transactions — see
 * db/index.ts). Statement ordering is intentional:
 *
 *   1. Hard-delete the credential / device / connection rows that grant
 *      access. These must go before the anonymization UPDATE so a
 *      crash after the UPDATE never leaves a still-active session for
 *      a user whose credentials we already wiped.
 *   2. Flip pending invitations to revoked and active disclosure_consents
 *      to revoked (the latter per FERPA, soft-delete only).
 *   3. Anonymize the `users` row.
 *   4. Insert the `user.deleted` audit row inside the same batch so a
 *      partial cascade never leaves an audit row claiming a deletion
 *      that never landed.
 *
 * Note on the scope check above: when [UNI-49] / [UNI-51] / [UNI-32] tables
 * are present (they are in this build), every cascade arm executes. The
 * issue body's "skip those branches if not yet shipped" hedge is moot as
 * of 2026-05-05.
 */
function buildDeleteCascade(input: DeleteCascadeInput): Array<{
  sql: string;
  params: readonly unknown[];
}> {
  const { targetId, targetEmail, now } = input;
  const anon = buildAnonymizedUser(targetId);

  return [
    // 1. Hard-delete credentials + device + connection rows.
    { sql: `DELETE FROM sessions WHERE user_id = ?`, params: [targetId] },
    { sql: `DELETE FROM mfa_challenges WHERE user_id = ?`, params: [targetId] },
    { sql: `DELETE FROM trusted_devices WHERE user_id = ?`, params: [targetId] },
    { sql: `DELETE FROM lms_connections WHERE user_id = ?`, params: [targetId] },
    { sql: `DELETE FROM lms_oauth_states WHERE user_id = ?`, params: [targetId] },
    // Parent-side credential rows are tied to the student via student_user_id.
    // Removing the user row would CASCADE these (FK ON DELETE CASCADE), but
    // we anonymize the user row instead, so explicitly clear them so a
    // standing parent session can't keep observing what is now a tombstone.
    {
      sql: `DELETE FROM parent_sessions WHERE student_user_id = ?`,
      params: [targetId],
    },
    {
      sql: `DELETE FROM parent_sign_in_tokens WHERE student_user_id = ?`,
      params: [targetId],
    },

    // 2. Flip pending invitations to revoked (matched by email) + active
    //    disclosure_consents to revoked (FERPA preserves the row but the
    //    permission must lapse).
    {
      sql: `UPDATE invitations
              SET status = 'revoked'
            WHERE email = ? AND status = 'pending'`,
      params: [targetEmail],
    },
    {
      sql: `UPDATE disclosure_consents
              SET revoked_at = ?, updated_at = ?
            WHERE student_user_id = ? AND revoked_at IS NULL`,
      params: [now, now, targetId],
    },

    // 3. Course-assignments rows for the deleted user flip to status
    //    'removed_user' if the schema supports it. The 0019 migration
    //    constrains the column to ('active','dropped'); an extension
    //    is out of scope for UNI-61 (would require another ALTER /
    //    table-recreate). For now mark them as 'dropped' which is the
    //    closest existing terminal state and matches the LMS-sync
    //    soft-delete semantic.
    {
      sql: `UPDATE course_assignments
              SET status = 'dropped', updated_at = ?
            WHERE user_id = ? AND status != 'dropped'`,
      params: [now, targetId],
    },

    // 4. Anonymize the users row itself. password_hash, mfa_*, and
    //    external_* are nulled so no future sign-in or LMS sync can
    //    rebind to the row. terms_accepted_at / lms_onboarding_dismissed_at
    //    are intentionally left in place per the spec ("historical fact").
    {
      sql: `UPDATE users
              SET name = ?,
                  email = ?,
                  password_hash = NULL,
                  mfa_secret = NULL,
                  mfa_recovery_codes_hash = NULL,
                  mfa_enabled_at = NULL,
                  external_provider = NULL,
                  external_id = NULL,
                  status = 'deleted',
                  updated_at = ?
            WHERE id = ?`,
      params: [anon.name, anon.email, now, targetId],
    },
  ];
}

export async function handleDeleteUser(
  ctx: RequestContext,
  userId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Coarse role gate up front so non-admins fail fast without leaking
  // existence (matches handleUpdateUserStatus and handleUpdateUserRole).
  if (!canManageUsers(actor.role)) {
    return errorResponse(403, "forbidden", "You do not have permission to remove users.");
  }

  const row = await loadUserRow(ctx.env.DB, userId);
  if (!row || !inReadScope(actor, row)) {
    return errorResponse(404, "not_found", "User not found.");
  }

  // Body is optional. `readJson` swallows parse errors and returns null,
  // which we coerce to an empty object so a SPA calling `fetch(...,
  // { method: "DELETE" })` without a body works the same as one passing
  // `{ reason: "..." }`. The schema will still 400 on a malformed shape
  // (e.g. `reason` longer than the cap or non-string).
  const raw = (await readJson(ctx.request)) ?? {};
  const parsed = deleteUserInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid delete payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const reason = parsed.data.reason ?? null;

  // Idempotency: re-deleting an already-removed user is a no-op success.
  // Returning the existing row lets the SPA refresh without surfacing a
  // false "deleted" toast for an action that didn't change anything.
  if (row.status === "deleted") {
    const idempotent: DeleteUserResult = {
      user: toUserListItem(row),
      idempotent: true,
    };
    return jsonOk(idempotent);
  }

  // Self-delete guard (super_admin AND university_admin alike).
  if (actor.id === userId) {
    await writeAuditLog(ctx.env.DB, {
      action: "user.deleted",
      actorUserId: actor.id,
      universityId: row.university_id,
      entityType: "user",
      entityId: userId,
      metadata: {
        denied: true,
        reason: "self_delete",
        attempted_role: row.role,
      },
    });
    return errorResponse(
      409,
      "cannot_delete_self",
      "You cannot remove your own account. Ask another admin.",
    );
  }

  // Privilege scope. university_admin cannot touch a super_admin or
  // another university_admin; canManageTargetUser encodes both. We write
  // a denied audit row so security review can see attempts that were
  // blocked by RBAC (matches handleUpdateUserRole / handleUpdateUserStatus).
  if (!inWriteScope(actor, row)) {
    await writeAuditLog(ctx.env.DB, {
      action: "user.deleted",
      actorUserId: actor.id,
      universityId: row.university_id,
      entityType: "user",
      entityId: userId,
      metadata: {
        denied: true,
        reason: "target_out_of_scope",
        attempted_role: row.role,
      },
    });
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to remove this user.",
    );
  }

  // Last-super_admin guard. The query mirrors the spec: count is the
  // active super_admins (any non-deleted status), and we refuse if
  // removing this one would drop us below 2. Run only when the target
  // *is* a super_admin so we don't query against the world for every
  // delete.
  if (row.role === "super_admin") {
    const countRow = await queryFirst<CountRow>(
      ctx.env.DB,
      `SELECT COUNT(1) AS c FROM users WHERE role = 'super_admin' AND status != 'deleted'`,
    );
    if (!countRow || countRow.c <= 1) {
      await writeAuditLog(ctx.env.DB, {
        action: "user.deleted",
        actorUserId: actor.id,
        universityId: row.university_id,
        entityType: "user",
        entityId: userId,
        metadata: {
          denied: true,
          reason: "last_super_admin",
          attempted_role: row.role,
        },
      });
      return errorResponse(
        409,
        "cannot_delete_last_super_admin",
        "You cannot remove the last Super Admin on this deploy.",
      );
    }
  }

  const now = new Date().toISOString();
  const cascade = buildDeleteCascade({
    targetId: userId,
    targetEmail: row.email,
    now,
  });

  // The audit row goes inside the same batch so a partial cascade can't
  // leave a 'user.deleted' row claiming success while the anonymization
  // UPDATE rolled back.
  const auditId = crypto.randomUUID();
  cascade.push({
    // Param order matches `writeAuditLog`'s shape (id, university_id,
    // actor_user_id, action, entity_type, entity_id, metadata_json) so any
    // row introspection (tests, audit-log filters) doesn't have to special-
    // case "this audit row was written from a batch".
    sql: `INSERT INTO audit_logs
            (id, university_id, actor_user_id, action, entity_type, entity_id, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      auditId,
      row.university_id,
      actor.id,
      "user.deleted",
      "user",
      userId,
      JSON.stringify({
        deleted_user_id: userId,
        deleted_user_email_redacted: redactEmail(row.email),
        actor_user_id: actor.id,
        reason,
        role_before: row.role,
      }),
    ],
  });

  try {
    await batch(ctx.env.DB, cascade);
  } catch (cause) {
    // The batch rolled back. Write a best-effort audit row so the failure
    // is visible to security review without blocking the response.
    console.error("user_delete_cascade_failed", {
      target_user_id: userId,
      actor_id: actor.id,
      cause,
    });
    await writeAuditLog(ctx.env.DB, {
      action: "user.deleted",
      actorUserId: actor.id,
      universityId: row.university_id,
      entityType: "user",
      entityId: userId,
      metadata: {
        denied: true,
        reason: "cascade_failed",
        attempted_role: row.role,
      },
    });
    return errorResponse(
      500,
      "delete_failed",
      "Could not remove user — the operation was rolled back. No data was changed.",
    );
  }

  // Privilege removal → invalidate every existing session for the deleted
  // user (the cascade already deleted the rows; we just emit per-session
  // audit rows so the audit-log surface shows what was revoked). Mirrors
  // the role/status-change path in revokeUserSessionsAfterPrivilegeChange.
  // The cascade already removed the sessions, so this query returns 0
  // rows; left here as a no-op so a future change to the cascade
  // ordering still produces matching audit entries.
  await revokeUserSessionsAfterPrivilegeChange(ctx, {
    targetUserId: userId,
    targetUniversityId: row.university_id,
    actorId: actor.id,
    reason: "status_change",
    metadata: { previous_status: row.status, new_status: "deleted" },
  });

  const refreshed = await loadUserRow(ctx.env.DB, userId);
  const result: DeleteUserResult = {
    user: refreshed
      ? toUserListItem(refreshed)
      : {
          ...toUserListItem(row),
          name: buildAnonymizedUser(userId).name,
          email: buildAnonymizedUser(userId).email,
          status: "deleted",
          updated_at: now,
        },
    idempotent: false,
  };
  return jsonOk(result);
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
