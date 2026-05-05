// LMS provider config admin surface (epic UNI-50 / sub-issue UNI-53).
//
//   GET    /api/lms/provider-configs       super_admin / university_admin —
//                                          per-provider config rows for the
//                                          caller's university plus a
//                                          registry summary so the UI can
//                                          render every provider, including
//                                          the unconfigured ones.
//   POST   /api/lms/provider-configs       create or update one provider's
//                                          config for the caller's
//                                          university.
//   DELETE /api/lms/provider-configs/:id   remove one provider config row.
//
// All three endpoints are gated to `super_admin` (any university) and
// `university_admin` (their own university only). Other roles get 403
// before any work happens. Writes always go through the field-encryption
// helper (apps/worker/src/crypto/field-encryption.ts) — D1 only ever sees
// the ciphertext for `client_secret_encrypted`. The plaintext is required
// in the request, used to encrypt, and then dropped on the floor; we
// never log it, never return it, and never store it.
//
// Audit:
//   - lms.provider_config.updated  on every successful create-or-update
//   - lms.provider_config.removed  on every successful delete
// Both rows carry `provider_id`, `enabled` (post-write), and a
// `secret_changed` boolean so post-incident review can tell whether a
// credential rotation actually happened. The OAuth client secret never
// appears in the audit row.

import {
  type LmsProviderConfigPublic,
  type LmsProviderConfigsResponse,
  type LmsProviderId,
  type LmsProviderRegistryEntry,
  LMS_PROVIDER_DISPLAY_NAMES,
  updateLmsProviderConfigInputSchema,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { encryptForUniversity } from "../crypto/field-encryption.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { lmsProviderRegistry } from "../lms/registry.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// All four ids defined in the schema CHECK constraint. We surface every
// one in the listing response so the admin UI can render each card,
// including providers (Blackboard / Moodle / Google Classroom) that
// don't have a registered implementation yet — the UI marks those as
// "Coming soon" rather than letting an admin save against them.
const ALL_PROVIDER_IDS: readonly LmsProviderId[] = [
  "canvas",
  "blackboard",
  "moodle",
  "google_classroom",
];

interface ProviderConfigRow extends Row {
  id: string;
  university_id: string;
  provider_id: LmsProviderId;
  base_url: string;
  client_id: string;
  client_secret_encrypted: string;
  enabled: number;
  configured_by_user_id: string | null;
  configured_at: string;
  updated_at: string;
}

const SELECT_BASE = `
  SELECT id, university_id, provider_id, base_url, client_id,
         client_secret_encrypted, enabled, configured_by_user_id,
         configured_at, updated_at
    FROM lms_provider_configs
`;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isAdminLike(actor: UserRow): boolean {
  return actor.role === "super_admin" || actor.role === "university_admin";
}

/**
 * Returns the universityId the caller is acting on, or a 4xx Response.
 *
 * - `super_admin`: may target any university via `?university_id=...`,
 *   defaults to their own home university (when set).
 * - `university_admin`: locked to their own university; the query
 *   parameter, if present, must match. Any cross-tenant attempt is a 403.
 */
function resolveTargetUniversity(
  ctx: RequestContext,
  actor: UserRow,
): { ok: true; universityId: string } | { ok: false; response: Response } {
  const requestedId = ctx.url.searchParams.get("university_id");
  if (actor.role === "super_admin") {
    const target = requestedId ?? actor.university_id ?? null;
    if (!target) {
      return {
        ok: false,
        response: errorResponse(
          400,
          "invalid_request",
          "No target university — pass ?university_id or sign in as a university member.",
        ),
      };
    }
    return { ok: true, universityId: target };
  }
  // university_admin: same-tenant only.
  if (!actor.university_id) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "forbidden",
        "You do not have permission to manage LMS integrations.",
      ),
    };
  }
  if (requestedId && requestedId !== actor.university_id) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "forbidden",
        "You can only manage LMS integrations for your own university.",
      ),
    };
  }
  return { ok: true, universityId: actor.university_id };
}

/**
 * Last-4 mask of the configured client_id for the listing endpoint. The
 * full value never leaks back to the UI: the admin who configured the
 * integration already knows it; everyone else only needs enough to
 * recognise the row at a glance and rule out copy-paste typos.
 */
function maskClientId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    // Pad shorter ids so the UI always renders four characters; rarely
    // hits in practice (real OAuth client ids are 40+ chars).
    return trimmed.padStart(4, "•");
  }
  return trimmed.slice(-4);
}

function rowToPublic(row: ProviderConfigRow): LmsProviderConfigPublic {
  return {
    id: row.id,
    university_id: row.university_id,
    provider_id: row.provider_id,
    base_url: row.base_url,
    client_id_last4: maskClientId(row.client_id),
    has_client_secret: row.client_secret_encrypted.length > 0,
    enabled: row.enabled === 1,
    configured_by_user_id: row.configured_by_user_id,
    configured_at: row.configured_at,
    updated_at: row.updated_at,
  };
}

async function loadConfigsForUniversity(
  db: D1Database,
  universityId: string,
): Promise<ProviderConfigRow[]> {
  return queryAll<ProviderConfigRow>(
    db,
    `${SELECT_BASE} WHERE university_id = ? ORDER BY provider_id ASC`,
    [universityId],
  );
}

async function loadConfigByUniversityAndProvider(
  db: D1Database,
  universityId: string,
  providerId: LmsProviderId,
): Promise<ProviderConfigRow | null> {
  return queryFirst<ProviderConfigRow>(
    db,
    `${SELECT_BASE} WHERE university_id = ? AND provider_id = ? LIMIT 1`,
    [universityId, providerId],
  );
}

async function loadConfigById(
  db: D1Database,
  id: string,
): Promise<ProviderConfigRow | null> {
  return queryFirst<ProviderConfigRow>(
    db,
    `${SELECT_BASE} WHERE id = ? LIMIT 1`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// GET /api/lms/provider-configs
// ---------------------------------------------------------------------------

export async function handleListLmsProviderConfigs(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to manage LMS integrations.",
    );
  }
  const target = resolveTargetUniversity(ctx, actor);
  if (!target.ok) return target.response;

  const rows = await loadConfigsForUniversity(ctx.env.DB, target.universityId);
  const byProvider = new Map<LmsProviderId, LmsProviderConfigPublic>();
  for (const row of rows) {
    byProvider.set(row.provider_id, rowToPublic(row));
  }

  const registeredIds = new Set(lmsProviderRegistry.ids());

  // Surface every provider the schema accepts, registered or not. The UI
  // uses `display_name` for the heading and a side-channel
  // (registeredIds) only via the `config !== null` indicator + the
  // implementation-status copy in the front-end. We don't expose the
  // registry-id list directly — it changes with build, not config.
  const providers: LmsProviderRegistryEntry[] = ALL_PROVIDER_IDS
    .filter((id) => registeredIds.has(id) || byProvider.has(id))
    .map((id) => ({
      provider_id: id,
      display_name: LMS_PROVIDER_DISPLAY_NAMES[id],
      config: byProvider.get(id) ?? null,
    }));

  // If a future build registers no providers but rows exist, still surface
  // the rows — admins shouldn't lose visibility into a config they own.
  // If neither is true, fall through to a single-Canvas card so the page
  // renders something actionable in dev.
  if (providers.length === 0) {
    providers.push({
      provider_id: "canvas",
      display_name: LMS_PROVIDER_DISPLAY_NAMES.canvas,
      config: null,
    });
  }

  const body: LmsProviderConfigsResponse = { providers };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/lms/provider-configs
// ---------------------------------------------------------------------------

export async function handleUpsertLmsProviderConfig(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to manage LMS integrations.",
    );
  }
  const target = resolveTargetUniversity(ctx, actor);
  if (!target.ok) return target.response;

  const raw = await readJson(ctx.request);
  const parsed = updateLmsProviderConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid LMS provider config payload.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }

  const { provider_id, base_url, client_id, client_secret, enabled } =
    parsed.data;

  const existing = await loadConfigByUniversityAndProvider(
    ctx.env.DB,
    target.universityId,
    provider_id,
  );

  // Secret rules:
  //   - first configure (no existing row): client_secret is required
  //     and must be non-empty.
  //   - re-edit: blank/missing client_secret keeps the existing
  //     ciphertext; non-empty client_secret rotates it.
  const newSecret = (client_secret ?? "").trim();
  if (!existing && newSecret.length === 0) {
    return errorResponse(
      400,
      "invalid_request",
      "Client secret is required when configuring a provider for the first time.",
      { issues: { client_secret: ["Client secret is required"] } },
    );
  }

  const now = new Date().toISOString();
  let secretChanged = false;
  let encryptedSecret = existing?.client_secret_encrypted ?? "";
  if (newSecret.length > 0) {
    encryptedSecret = await encryptForUniversity(
      ctx.env,
      newSecret,
      target.universityId,
    );
    secretChanged = true;
  }
  const enabledInt = enabled ? 1 : 0;

  let savedRow: ProviderConfigRow | null = null;
  if (existing) {
    await execute(
      ctx.env.DB,
      `UPDATE lms_provider_configs
          SET base_url = ?,
              client_id = ?,
              client_secret_encrypted = ?,
              enabled = ?,
              configured_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        base_url,
        client_id,
        encryptedSecret,
        enabledInt,
        actor.id,
        now,
        existing.id,
      ],
    );
    savedRow = await loadConfigById(ctx.env.DB, existing.id);
  } else {
    const id = crypto.randomUUID();
    await execute(
      ctx.env.DB,
      `INSERT INTO lms_provider_configs
         (id, university_id, provider_id, base_url, client_id,
          client_secret_encrypted, enabled, configured_by_user_id,
          configured_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        target.universityId,
        provider_id,
        base_url,
        client_id,
        encryptedSecret,
        enabledInt,
        actor.id,
        now,
        now,
      ],
    );
    savedRow = await loadConfigById(ctx.env.DB, id);
  }

  await writeAuditLog(ctx.env.DB, {
    action: "lms.provider_config.updated",
    actorUserId: actor.id,
    universityId: target.universityId,
    entityType: "lms_provider_config",
    entityId: savedRow?.id ?? null,
    metadata: {
      provider_id,
      base_url,
      enabled: enabledInt === 1,
      created: !existing,
      secret_changed: secretChanged,
    },
  });

  if (!savedRow) {
    return errorResponse(
      500,
      "internal_error",
      "Saved row could not be re-read after write.",
    );
  }
  return jsonOk(rowToPublic(savedRow));
}

// ---------------------------------------------------------------------------
// DELETE /api/lms/provider-configs/:id
// ---------------------------------------------------------------------------

export async function handleDeleteLmsProviderConfig(
  ctx: RequestContext,
  configId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to manage LMS integrations.",
    );
  }

  const existing = await loadConfigById(ctx.env.DB, configId);
  if (!existing) {
    return errorResponse(404, "not_found", "Provider config not found.");
  }

  // Tenant scoping: super_admin can delete any row; university_admin
  // only their own. We don't leak the row's existence to a non-owner —
  // a cross-tenant DELETE returns the same 404 as a totally unknown id.
  if (
    actor.role !== "super_admin" &&
    !(
      actor.role === "university_admin" &&
      actor.university_id === existing.university_id
    )
  ) {
    return errorResponse(404, "not_found", "Provider config not found.");
  }

  await execute(
    ctx.env.DB,
    `DELETE FROM lms_provider_configs WHERE id = ?`,
    [configId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "lms.provider_config.removed",
    actorUserId: actor.id,
    universityId: existing.university_id,
    entityType: "lms_provider_config",
    entityId: configId,
    metadata: {
      provider_id: existing.provider_id,
      base_url: existing.base_url,
    },
  });

  return jsonOk({ ok: true });
}
