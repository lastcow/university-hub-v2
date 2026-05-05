// Settings endpoints (epic UNI-1 §9 #13, §17, §29).
//
//   GET   /api/settings/system-status     high-level health/config summary
//   GET   /api/settings/mailgun-status    per-var Configured / Missing —
//                                          NEVER returns secret values
//   PATCH /api/settings/university        super_admin or that university's admin
//   PATCH /api/settings/account           current user's own profile + password
//
// The Mailgun status endpoint is the security-sensitive one: it must only
// emit one of the two literal status strings per variable, plus the plain
// `MAILGUN_REGION` value if set (region is not a secret per §29). The four
// secret-bearing vars (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`,
// `MAILGUN_FROM_EMAIL`, `MAILGUN_FROM_NAME`) never expose their values.
//
// All writes audit-log via `settings.updated`. Failures emit a denied entry.

import {
  type MailgunStatusResponse,
  type MailgunVarKey,
  type MailgunVarStatus,
  type MailgunVarStatusEntry,
  type SystemSettingsResponse,
  type SystemStatusResponse,
  type University,
  type UniversityStatus,
  type SessionUser,
  updateSettingsAccountInputSchema,
  updateSettingsUniversityInputSchema,
  updateSystemSettingsInputSchema,
} from "@university-hub/shared";

import { hashPassword, verifyPassword } from "../auth/password.js";
import { toSessionUser, type UserRow } from "../auth/session.js";
import { revokeAllTrustedDevicesForUser } from "../auth/trusted-device.js";
import { execute, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import {
  MFA_TRUSTED_DEVICE_DAYS_KEY,
  getMfaTrustedDeviceDays,
  setSystemSettingString,
} from "../services/system-settings.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type UniversityRow = Row & {
  id: string;
  name: string;
  slug: string | null;
  status: UniversityStatus;
  created_at: string;
  updated_at: string;
};

const SELECT_UNIVERSITY = `
  SELECT id, name, slug, status, created_at, updated_at
    FROM universities
`;

function toUniversity(row: UniversityRow): University {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mailgun status (no secret values)
// ---------------------------------------------------------------------------

function isPresent(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length === 0) return false;
  // Treat the `.dev.vars.example` placeholder sentinel ("replace-with-...") as
  // unconfigured so dev environments naturally show "Missing configuration"
  // until real secrets are set, matching the operational note on UNI-1.
  return !v.toLowerCase().startsWith("replace-with-");
}

function mailgunStatus(value: string | undefined): MailgunVarStatus {
  return isPresent(value) ? "Configured" : "Missing configuration";
}

function buildMailgunStatus(env: Env): MailgunStatusResponse {
  // The four required vars: status only. We never read or echo the value.
  const required: Array<{ key: MailgunVarKey; value: string | undefined }> = [
    { key: "MAILGUN_API_KEY", value: env.MAILGUN_API_KEY },
    { key: "MAILGUN_DOMAIN", value: env.MAILGUN_DOMAIN },
    { key: "MAILGUN_FROM_EMAIL", value: env.MAILGUN_FROM_EMAIL },
    { key: "MAILGUN_FROM_NAME", value: env.MAILGUN_FROM_NAME },
  ];

  const variables: MailgunVarStatusEntry[] = required.map(({ key, value }) => ({
    key,
    status: mailgunStatus(value),
    value: null,
    optional: false,
  }));

  // Region is optional and not a secret — surface its plain value when set.
  const regionPresent = isPresent(env.MAILGUN_REGION);
  variables.push({
    key: "MAILGUN_REGION",
    status: regionPresent ? "Configured" : "Missing configuration",
    value: regionPresent ? (env.MAILGUN_REGION ?? "").trim() : null,
    optional: true,
  });

  const configured = required.every(({ value }) => isPresent(value));
  return { configured, variables };
}

export function handleGetMailgunStatus(ctx: RequestContext): Response {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  // Any signed-in user may read the status (no values are returned). The
  // Settings UI shows it under the same section the spec defines for §29.
  return jsonOk(buildMailgunStatus(ctx.env));
}

// ---------------------------------------------------------------------------
// System status (high-level health/config summary)
// ---------------------------------------------------------------------------

export async function handleGetSystemStatus(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;

  // A trivial DB ping. We don't surface the cause of failure to the client —
  // just whether the connection is healthy.
  let databaseOk = false;
  try {
    await queryFirst<Row>(ctx.env.DB, "SELECT 1 AS ok");
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  const mailgun = buildMailgunStatus(ctx.env);
  const body: SystemStatusResponse = {
    app_env: ctx.env.APP_ENV ?? "development",
    app_name: ctx.env.APP_NAME ?? "University Hub",
    app_base_url: ctx.env.APP_BASE_URL ?? null,
    mailgun_configured: mailgun.configured,
    database_ok: databaseOk,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// PATCH /api/settings/university
// ---------------------------------------------------------------------------

function canEditUniversity(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") {
    return actor.university_id === universityId;
  }
  return false;
}

export async function handleUpdateUniversitySettings(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // university_id can come from query (super_admin) or default to the actor's
  // own. Non-super_admins cannot retarget another university.
  const requestedId = ctx.url.searchParams.get("university_id");
  const targetId = requestedId ?? actor.university_id ?? null;

  if (!targetId) {
    return errorResponse(
      400,
      "invalid_request",
      "No target university — pass ?university_id or sign in as a university member.",
    );
  }

  if (
    actor.role !== "super_admin" &&
    !(actor.role === "university_admin" && actor.university_id === targetId)
  ) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit university settings.",
    );
  }

  const existing = await queryFirst<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [targetId],
  );
  if (!existing) return errorResponse(404, "not_found", "University not found.");

  if (!canEditUniversity(actor, targetId)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit this university.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateSettingsUniversityInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid update payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};

  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
    changed.name = parsed.data.name;
  }
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    if (parsed.data.slug) {
      const collision = await queryFirst<{ id: string }>(
        ctx.env.DB,
        `SELECT id FROM universities WHERE slug = ? AND id != ? LIMIT 1`,
        [parsed.data.slug, targetId],
      );
      if (collision) {
        return errorResponse(409, "slug_taken", "That slug is already in use.");
      }
    }
    updates.push("slug = ?");
    params.push(parsed.data.slug);
    changed.slug = parsed.data.slug;
  }

  if (updates.length === 0) {
    return jsonOk(toUniversity(existing));
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(targetId);

  await execute(
    ctx.env.DB,
    `UPDATE universities SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  await writeAuditLog(ctx.env.DB, {
    action: "settings.updated",
    actorUserId: actor.id,
    universityId: targetId,
    entityType: "university",
    entityId: targetId,
    metadata: { scope: "university", changed },
  });

  const refreshed = await queryFirst<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [targetId],
  );
  return jsonOk(refreshed ? toUniversity(refreshed) : toUniversity(existing));
}

// ---------------------------------------------------------------------------
// PATCH /api/settings/account
// ---------------------------------------------------------------------------

export async function handleUpdateAccountSettings(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const raw = await readJson(ctx.request);
  const parsed = updateSettingsAccountInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid account payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const wantsPasswordChange =
    parsed.data.current_password !== undefined &&
    parsed.data.new_password !== undefined;

  // Verify the current password BEFORE applying any change. This is the
  // security-sensitive gate from the issue spec: the request must be rejected
  // when the current password is wrong.
  if (wantsPasswordChange) {
    const ok = await verifyPassword(
      parsed.data.current_password as string,
      actor.password_hash,
    );
    if (!ok) {
      // Audit the failed attempt — useful for detecting credential probing.
      await writeAuditLog(ctx.env.DB, {
        action: "settings.updated",
        actorUserId: actor.id,
        universityId: actor.university_id,
        entityType: "user",
        entityId: actor.id,
        metadata: {
          scope: "account",
          denied: true,
          reason: "wrong_current_password",
        },
      });
      return errorResponse(
        400,
        "wrong_current_password",
        "Current password is incorrect.",
      );
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};

  if (parsed.data.name !== undefined && parsed.data.name !== actor.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
    changed.name = parsed.data.name;
  }

  if (wantsPasswordChange) {
    const newHash = await hashPassword(parsed.data.new_password as string);
    updates.push("password_hash = ?");
    params.push(newHash);
    changed.password_changed = true;
  }

  // Password change revokes every trusted-device row for this user
  // (UNI-47 acceptance: "On any password change OR MFA-secret rotation,
  // revoke all of the user's trusted devices."). Doing it before the
  // UPDATE keeps the ordering consistent if the UPDATE somehow fails —
  // worst case we revoke trust without the password having actually
  // changed, which is the safer side to err on.
  let revokedTrustedDevices = 0;
  if (wantsPasswordChange) {
    const ids = await revokeAllTrustedDevicesForUser(ctx.env.DB, actor.id);
    revokedTrustedDevices = ids.length;
    for (const id of ids) {
      await writeAuditLog(ctx.env.DB, {
        action: "mfa.trusted_device_revoked",
        actorUserId: actor.id,
        universityId: actor.university_id,
        entityType: "trusted_device",
        entityId: id,
        metadata: { reason: "password_changed", target_user_id: actor.id },
      });
    }
    if (revokedTrustedDevices > 0) {
      changed.trusted_devices_revoked = revokedTrustedDevices;
    }
  }

  if (updates.length === 0) {
    const sessionUser: SessionUser = toSessionUser(actor);
    return jsonOk(sessionUser);
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(actor.id);

  await execute(
    ctx.env.DB,
    `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  await writeAuditLog(ctx.env.DB, {
    action: "settings.updated",
    actorUserId: actor.id,
    universityId: actor.university_id,
    entityType: "user",
    entityId: actor.id,
    metadata: { scope: "account", changed },
  });

  const refreshedRow = await queryFirst<UserRow>(
    ctx.env.DB,
    `SELECT id, email, password_hash, name, role, status, university_id,
            last_sign_in_at, created_at, updated_at
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [actor.id],
  );

  const sessionUser: SessionUser = toSessionUser(refreshedRow ?? actor);
  return jsonOk(sessionUser);
}

// ---------------------------------------------------------------------------
// GET /api/settings/system
//
// Surface for super_admin-editable scalar settings (UNI-47). Today there is
// only one — `mfa_trusted_device_days` — but the response shape is an
// object so we can add more without a breaking change.
//
// Read is open to super_admin and university_admin so the latter can see
// the active trust window in their own UI ("Newly-trusted devices last for
// N days") even though they cannot edit it. Other roles get 403.
// ---------------------------------------------------------------------------

function canReadSystemSettings(actor: UserRow): boolean {
  return actor.role === "super_admin" || actor.role === "university_admin";
}

export async function handleGetSystemSettings(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  if (!canReadSystemSettings(auth.user)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to read system settings.",
    );
  }
  const days = await getMfaTrustedDeviceDays(ctx.env.DB);
  const body: SystemSettingsResponse = {
    mfa_trusted_device_days: days,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// PATCH /api/settings/system
//
// super_admin-only. Reducing the window does NOT retroactively shrink the
// `expires_at` on existing `trusted_devices` rows; the new value only
// applies to newly-granted trusts. The PR description / help text on the
// settings page calls this out so an operator who tightens the window
// understands why existing devices linger until their natural expiry.
// ---------------------------------------------------------------------------

export async function handleUpdateSystemSettings(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (actor.role !== "super_admin") {
    await writeAuditLog(ctx.env.DB, {
      action: "settings.updated",
      actorUserId: actor.id,
      universityId: actor.university_id,
      entityType: "system",
      entityId: null,
      metadata: { scope: "system", denied: true, reason: "forbidden" },
    });
    return errorResponse(
      403,
      "forbidden",
      "Only super administrators can edit system settings.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateSystemSettingsInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid system-settings payload.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }

  const changed: Record<string, unknown> = {};
  if (parsed.data.mfa_trusted_device_days !== undefined) {
    const previous = await getMfaTrustedDeviceDays(ctx.env.DB);
    if (previous !== parsed.data.mfa_trusted_device_days) {
      await setSystemSettingString(
        ctx.env.DB,
        MFA_TRUSTED_DEVICE_DAYS_KEY,
        String(parsed.data.mfa_trusted_device_days),
        actor.id,
      );
      changed.mfa_trusted_device_days = {
        from: previous,
        to: parsed.data.mfa_trusted_device_days,
      };
    }
  }

  if (Object.keys(changed).length > 0) {
    await writeAuditLog(ctx.env.DB, {
      action: "settings.updated",
      actorUserId: actor.id,
      universityId: actor.university_id,
      entityType: "system",
      entityId: null,
      metadata: { scope: "system", changed },
    });
  }

  const days = await getMfaTrustedDeviceDays(ctx.env.DB);
  const body: SystemSettingsResponse = {
    mfa_trusted_device_days: days,
  };
  return jsonOk(body);
}
