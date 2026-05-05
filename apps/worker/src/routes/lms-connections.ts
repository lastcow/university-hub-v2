// User-facing LMS connect flow (epic UNI-50 / sub-issue UNI-54;
// reshaped in UNI-63 to use per-user Personal Access Tokens).
//
//   GET    /api/lms/connections                       any authenticated user —
//                                                     their own connections,
//                                                     no token material.
//   POST   /api/lms/connections/canvas                accept a PAT, validate
//                                                     against `/api/v1/users/self`,
//                                                     encrypt and store on 200.
//   POST   /api/lms/connections/:id/disconnect        delete the row outright;
//                                                     write `lms.disconnected`
//                                                     audit row.
//
// PATs never leave the Worker. The listing endpoint surfaces only
// metadata (status, last_synced_at, base_url, etc.); the connect flow
// stores the access token via `encryptForUniversity` and reads it back
// only at the moment of an outbound Canvas API call. The disconnect
// handler deletes the row outright (PAT flow has no historical value
// to preserve, unlike OAuth's revoked-but-rotatable-refresh-token
// shape).
//
// CSRF: the PAT submit endpoint is a same-origin authenticated POST
// with no third-party redirect; standard cookie-bearer auth + CORS
// gating apply. There's no state parameter to mint, no callback to
// validate.

import {
  type ConnectLmsConnectionResponse,
  type DisconnectLmsConnectionResponse,
  type LmsConnectionPublic,
  type LmsConnectionStatus,
  type LmsConnectionsResponse,
  type LmsProviderId,
  connectCanvasConnectionInputSchema,
} from "@university-hub/shared";

import { encryptForUniversity } from "../crypto/field-encryption.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { validatePersonalAccessToken } from "../lms/canvas/api.js";
import { CanvasApiError } from "../lms/canvas/http.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

interface ProviderConfigRow extends Row {
  id: string;
  university_id: string;
  provider_id: LmsProviderId;
  base_url: string;
  enabled: number;
  configured_by_user_id: string | null;
  configured_at: string;
  updated_at: string;
}

interface ConnectionRow extends Row {
  id: string;
  user_id: string;
  university_id: string;
  provider_id: LmsProviderId;
  base_url: string;
  access_token_encrypted: string;
  external_user_id: string | null;
  status: LmsConnectionStatus;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CONNECTION = `
  SELECT id, user_id, university_id, provider_id, base_url,
         access_token_encrypted, external_user_id, status, last_synced_at,
         created_at, updated_at
    FROM lms_connections
`;

const SELECT_PROVIDER_CONFIG = `
  SELECT id, university_id, provider_id, base_url,
         enabled, configured_by_user_id,
         configured_at, updated_at
    FROM lms_provider_configs
`;

function rowToPublic(row: ConnectionRow): LmsConnectionPublic {
  return {
    id: row.id,
    user_id: row.user_id,
    university_id: row.university_id,
    provider_id: row.provider_id,
    base_url: row.base_url,
    status: row.status,
    last_synced_at: (row.last_synced_at ?? null) as
      | LmsConnectionPublic["last_synced_at"],
    created_at: row.created_at as LmsConnectionPublic["created_at"],
    updated_at: row.updated_at as LmsConnectionPublic["updated_at"],
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function loadProviderConfig(
  db: D1Database,
  universityId: string,
  providerId: LmsProviderId,
): Promise<ProviderConfigRow | null> {
  return queryFirst<ProviderConfigRow>(
    db,
    `${SELECT_PROVIDER_CONFIG} WHERE university_id = ? AND provider_id = ? LIMIT 1`,
    [universityId, providerId],
  );
}

async function loadConnectionsForUser(
  db: D1Database,
  userId: string,
): Promise<ConnectionRow[]> {
  return queryAll<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE user_id = ? ORDER BY created_at ASC`,
    [userId],
  );
}

async function loadConnectionById(
  db: D1Database,
  id: string,
): Promise<ConnectionRow | null> {
  return queryFirst<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE id = ? LIMIT 1`,
    [id],
  );
}

async function loadConnectionByUserAndProvider(
  db: D1Database,
  userId: string,
  providerId: LmsProviderId,
): Promise<ConnectionRow | null> {
  return queryFirst<ConnectionRow>(
    db,
    `${SELECT_CONNECTION} WHERE user_id = ? AND provider_id = ? LIMIT 1`,
    [userId, providerId],
  );
}

// ---------------------------------------------------------------------------
// GET /api/lms/connections — caller's own connections, no tokens.
// ---------------------------------------------------------------------------

export async function handleListLmsConnections(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const rows = await loadConnectionsForUser(ctx.env.DB, auth.user.id);
  const body: LmsConnectionsResponse = {
    connections: rows.map(rowToPublic),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/lms/connections/canvas
//
// Accept a PAT in the request body, probe it against the configured
// Canvas tenant's `/api/v1/users/self`, and on a 200 response encrypt
// and persist the row. On a 401 (Canvas rejected the PAT) return
// `invalid_token` and write nothing — the user re-pastes a fresh
// token. On any other failure path return a `lms_upstream_error` so
// the SPA can render a generic retry copy.
// ---------------------------------------------------------------------------

export async function handleConnectCanvasConnection(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!actor.university_id) {
    return errorResponse(
      400,
      "invalid_request",
      "Your account is not associated with a university; LMS connections are scoped per-university.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = connectCanvasConnectionInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid Canvas connect payload.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }
  const personalAccessToken = parsed.data.personal_access_token;

  const config = await loadProviderConfig(
    ctx.env.DB,
    actor.university_id,
    "canvas",
  );
  if (!config || config.enabled !== 1) {
    return errorResponse(
      400,
      "lms_not_configured",
      "Canvas is not configured for your university yet — ask your administrator to enable it in Settings → Integrations.",
    );
  }

  // Validate the PAT against Canvas before persisting anything. This is
  // the only path that touches the network with the user-supplied token
  // before encryption, and the token never leaves this function's
  // closure in plaintext.
  //
  // Capture the validation response's `external_user_id` (Canvas's
  // `users/self.id`). The connection's owner-on-the-LMS-side is the
  // strongest possible match key during reconciliation: when an
  // enrollment carries this id, we know it is THIS Hub user without
  // needing email parity (UNI-67 iteration 3).
  let externalUserId: string;
  try {
    const validation = await validatePersonalAccessToken(
      config.base_url,
      personalAccessToken,
    );
    externalUserId = validation.external_user_id;
  } catch (cause) {
    if (cause instanceof CanvasApiError && cause.status === 401) {
      return errorResponse(
        400,
        "invalid_token",
        "Canvas rejected this access token. Generate a new one in Account → Settings → \"+ New Access Token\" and try again.",
      );
    }
    // Network / non-401 — surface a generic failure so the SPA shows a
    // retry path. We still don't write anything.
    console.error("lms_pat_validate_failed", {
      provider: "canvas",
      university_id: actor.university_id,
      cause,
    });
    return errorResponse(
      502,
      "lms_upstream_error",
      "Couldn't reach Canvas to validate the access token. Check the base URL configured for your university and try again.",
    );
  }

  // Encrypt for the per-tenant key. The plaintext PAT is dropped on
  // the floor as soon as this call returns; we never log it, never
  // return it, never write it to D1 in cleartext.
  const accessTokenEncrypted = await encryptForUniversity(
    ctx.env,
    personalAccessToken,
    actor.university_id,
  );

  const now = new Date().toISOString();
  const existing = await loadConnectionByUserAndProvider(
    ctx.env.DB,
    actor.id,
    "canvas",
  );
  let connectionId: string;
  let created: boolean;
  if (existing) {
    connectionId = existing.id;
    created = false;
    await execute(
      ctx.env.DB,
      `UPDATE lms_connections
          SET university_id = ?,
              base_url = ?,
              access_token_encrypted = ?,
              external_user_id = ?,
              status = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        actor.university_id,
        config.base_url,
        accessTokenEncrypted,
        externalUserId,
        "active",
        now,
        existing.id,
      ],
    );
  } else {
    connectionId = crypto.randomUUID();
    created = true;
    await execute(
      ctx.env.DB,
      `INSERT INTO lms_connections
         (id, user_id, university_id, provider_id, base_url,
          access_token_encrypted, external_user_id, status, last_synced_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        connectionId,
        actor.id,
        actor.university_id,
        "canvas",
        config.base_url,
        accessTokenEncrypted,
        externalUserId,
        "active",
        null,
        now,
        now,
      ],
    );
  }

  await writeAuditLog(ctx.env.DB, {
    action: "lms.connected",
    actorUserId: actor.id,
    universityId: actor.university_id,
    entityType: "lms_connection",
    entityId: connectionId,
    metadata: {
      provider_id: "canvas",
      created,
    },
  });

  // UNI-57: a successful connect (from any origin) means the user has
  // demonstrated intent. Stamp `users.lms_onboarding_dismissed_at` with
  // COALESCE so we preserve the original timestamp on a re-connect.
  await execute(
    ctx.env.DB,
    `UPDATE users
        SET lms_onboarding_dismissed_at =
              COALESCE(lms_onboarding_dismissed_at, ?),
            updated_at = ?
      WHERE id = ?`,
    [now, now, actor.id],
  );

  // Re-read so the response carries the canonical row (mirrors the
  // disconnect handler's pattern).
  const reread = await loadConnectionById(ctx.env.DB, connectionId);
  if (!reread) {
    return errorResponse(
      500,
      "internal_error",
      "Connection row could not be re-read after save.",
    );
  }
  const body: ConnectLmsConnectionResponse = {
    ok: true,
    connection: rowToPublic(reread),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/lms/connections/:id/disconnect
//
// Delete the row outright. With OAuth gone there's no refresh token to
// keep around, no provider-side revocation API to call back, and no
// historical interest in a "previously connected then disconnected"
// stub. The audit log preserves the disconnect event.
// ---------------------------------------------------------------------------

export async function handleDisconnectLmsConnection(
  ctx: RequestContext,
  connectionId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await loadConnectionById(ctx.env.DB, connectionId);
  if (!existing || existing.user_id !== actor.id) {
    // Tenant scoping: cloak the row's existence to a non-owner. A user
    // can only disconnect their own connections; a super_admin who
    // wants to surgically revoke someone else's Canvas link can do it
    // directly in D1 (no admin-on-behalf-of-user surface in Phase 1).
    return errorResponse(404, "not_found", "Connection not found.");
  }

  // Snapshot for the audit row before the DELETE.
  const previousStatus = existing.status;
  const previousProviderId = existing.provider_id;
  const previousUniversityId = existing.university_id;

  await execute(
    ctx.env.DB,
    `DELETE FROM lms_connections WHERE id = ?`,
    [existing.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "lms.disconnected",
    actorUserId: actor.id,
    universityId: previousUniversityId,
    entityType: "lms_connection",
    entityId: existing.id,
    metadata: {
      provider_id: previousProviderId,
      previous_status: previousStatus,
    },
  });

  return jsonOk<DisconnectLmsConnectionResponse>({ ok: true });
}
