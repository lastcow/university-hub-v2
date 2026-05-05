// "Trusted devices" management surface (UNI-47).
//
//   GET    /api/auth/trusted-devices                      list active rows for the caller
//   DELETE /api/auth/trusted-devices/:id                  revoke a specific row owned by the caller
//   POST   /api/auth/trusted-devices/revoke-all           revoke every row for the caller
//   GET    /api/users/:userId/trusted-devices             super_admin admin-of-other read
//   POST   /api/users/:userId/trusted-devices/revoke-all  super_admin admin-of-other revoke-all
//
// The own-user surface is open to any authenticated user (rows are only
// minted for `university_admin` today, so other roles will see empty
// lists). The admin-of-other surface is super_admin-only — `university_
// admin` can manage their own trust state but not another admin's.
//
// Privacy: list responses truncate IPs to /24 (IPv4) or /48 (IPv6) and
// trim user-agent strings to ~80 chars, matching the existing UNI-26
// active-sessions surface. Full IPs stay in `trusted_devices.ip_address`
// for the bypass exact-match check; the UI never needs them.
//
// Audit: every revoke writes a `mfa.trusted_device_revoked` row with the
// reason ("manual" / "revoke_all" / "admin_revoke") so the admin audit
// log can attribute sweeps.

import type {
  TrustedDeviceListItem,
  TrustedDeviceListResponse,
  TrustedDeviceRevokeAllResponse,
} from "@university-hub/shared";

import {
  deleteTrustedDeviceById,
  listTrustedDevicesForUser,
  revokeAllTrustedDevicesForUser,
  type TrustedDeviceRow,
} from "../auth/trusted-device.js";
import type { Env } from "../env.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { getMfaTrustedDeviceDays } from "../services/system-settings.js";
import { errorResponse, jsonOk } from "../utils/responses.js";
import { truncateIp, truncateUserAgent } from "./sessions.js";

const TRUSTED_DEVICE_COOKIE_DEFAULT = "university_hub_device_trust";

export function trustedDeviceCookieName(env: Env): string {
  return env.TRUSTED_DEVICE_COOKIE_NAME || TRUSTED_DEVICE_COOKIE_DEFAULT;
}

function rowToListItem(row: TrustedDeviceRow): TrustedDeviceListItem {
  return {
    id: row.id,
    ip_excerpt: truncateIp(row.ip_address),
    user_agent_excerpt: truncateUserAgent(row.user_agent),
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/auth/trusted-devices
// ---------------------------------------------------------------------------

export async function handleListTrustedDevices(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await listTrustedDevicesForUser(ctx.env.DB, auth.user.id);
  const trustWindowDays = await getMfaTrustedDeviceDays(ctx.env.DB);
  const body: TrustedDeviceListResponse = {
    trusted_devices: rows.map(rowToListItem),
    trust_window_days: trustWindowDays,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// DELETE /api/auth/trusted-devices/:id
// ---------------------------------------------------------------------------

export async function handleRevokeTrustedDevice(
  ctx: RequestContext,
  trustedDeviceId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  // Look up first so we can 404 cleanly on a foreign id and so the audit
  // row is tied to a known device id.
  const rows = await listTrustedDevicesForUser(ctx.env.DB, auth.user.id);
  const target = rows.find((r) => r.id === trustedDeviceId);
  if (!target) {
    return errorResponse(404, "not_found", "Trusted device not found.");
  }
  await deleteTrustedDeviceById(ctx.env.DB, trustedDeviceId);
  await writeAuditLog(ctx.env.DB, {
    action: "mfa.trusted_device_revoked",
    actorUserId: auth.user.id,
    universityId: auth.user.university_id,
    entityType: "trusted_device",
    entityId: trustedDeviceId,
    metadata: { reason: "manual", target_user_id: auth.user.id },
  });
  return jsonOk({ ok: true } as const);
}

// ---------------------------------------------------------------------------
// POST /api/auth/trusted-devices/revoke-all
// ---------------------------------------------------------------------------

export async function handleRevokeAllTrustedDevices(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const ids = await revokeAllTrustedDevicesForUser(ctx.env.DB, auth.user.id);
  for (const id of ids) {
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.trusted_device_revoked",
      actorUserId: auth.user.id,
      universityId: auth.user.university_id,
      entityType: "trusted_device",
      entityId: id,
      metadata: { reason: "revoke_all", target_user_id: auth.user.id },
    });
  }
  const body: TrustedDeviceRevokeAllResponse = { revoked_count: ids.length };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// GET /api/users/:userId/trusted-devices         (super_admin only)
// POST /api/users/:userId/trusted-devices/revoke-all  (super_admin only)
// ---------------------------------------------------------------------------

export async function handleAdminListTrustedDevices(
  ctx: RequestContext,
  targetUserId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  if (auth.user.role !== "super_admin") {
    return errorResponse(
      403,
      "forbidden",
      "Only super administrators can view another user's trusted devices.",
    );
  }
  const rows = await listTrustedDevicesForUser(ctx.env.DB, targetUserId);
  const trustWindowDays = await getMfaTrustedDeviceDays(ctx.env.DB);
  const body: TrustedDeviceListResponse = {
    trusted_devices: rows.map(rowToListItem),
    trust_window_days: trustWindowDays,
  };
  return jsonOk(body);
}

export async function handleAdminRevokeAllTrustedDevices(
  ctx: RequestContext,
  targetUserId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  if (auth.user.role !== "super_admin") {
    return errorResponse(
      403,
      "forbidden",
      "Only super administrators can revoke another user's trusted devices.",
    );
  }
  const ids = await revokeAllTrustedDevicesForUser(ctx.env.DB, targetUserId);
  for (const id of ids) {
    await writeAuditLog(ctx.env.DB, {
      action: "mfa.trusted_device_revoked",
      actorUserId: auth.user.id,
      universityId: auth.user.university_id,
      entityType: "trusted_device",
      entityId: id,
      metadata: { reason: "admin_revoke", target_user_id: targetUserId },
    });
  }
  const body: TrustedDeviceRevokeAllResponse = { revoked_count: ids.length };
  return jsonOk(body);
}
