// Privacy policy + ToS surfaces (epic UNI-21 / sub-issue UNI-34).
//
//   GET   /api/legal/:kind                  public — current ToS / Privacy
//   GET   /api/legal/acknowledgment-status  authed — does the user need to
//                                                    re-accept the current
//                                                    ToS / Privacy?
//   POST  /api/legal/accept                 authed — record acceptance
//   GET   /api/legal/admin                  super_admin / university_admin —
//                                            current docs (with body) for
//                                            the actor's university (or any,
//                                            when super_admin passes
//                                            ?university_id=)
//   PUT   /api/legal/admin/:kind            same RBAC — save body, optional
//                                            version bump (forces re-accept)
//
// Public reads resolve in this order:
//   1. ?university_id= (super_admin tooling) or ?token= (invitation flow,
//      so the accept page can show the right customer's text)
//   2. global default (university_id IS NULL row in legal_documents)
//   3. fall back to the seeded boilerplate from services/legal-defaults.ts
//      when the global row is missing (fresh deploy before any admin saved)
//
// Customer overrides save into legal_documents with that customer's
// university_id. The version starts at 1; admins choose whether to bump
// it on save. Non-bumped saves are typo fixes and don't trigger
// re-acceptance.

import {
  acceptLegalInputSchema,
  legalDocumentKindSchema,
  updateLegalDocumentInputSchema,
  type LegalAcceptResponse,
  type LegalAcknowledgmentStatus,
  type LegalAdminDocument,
  type LegalAdminResponse,
  type LegalDocument,
  type LegalDocumentKind,
} from "@university-hub/shared";

import { hashInvitationToken } from "../auth/invitation-token.js";
import type { UserRow } from "../auth/session.js";
import { execute, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import {
  defaultBodyForKind,
  renderLegalTemplate,
} from "../services/legal-defaults.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type LegalRow = Row & {
  id: string;
  university_id: string | null;
  kind: LegalDocumentKind;
  version: number;
  body_md: string;
  published_at: string;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type LegalRowWithMeta = LegalRow & {
  university_name: string | null;
  updated_by_name: string | null;
};

const SELECT_BASE = `
  SELECT ld.id, ld.university_id, ld.kind, ld.version, ld.body_md,
         ld.published_at, ld.updated_by_user_id, ld.created_at, ld.updated_at,
         un.name AS university_name,
         u.name  AS updated_by_name
    FROM legal_documents ld
    LEFT JOIN universities un ON un.id = ld.university_id
    LEFT JOIN users u         ON u.id  = ld.updated_by_user_id
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

async function loadCustomerRow(
  db: D1Database,
  universityId: string,
  kind: LegalDocumentKind,
): Promise<LegalRowWithMeta | null> {
  return queryFirst<LegalRowWithMeta>(
    db,
    `${SELECT_BASE} WHERE ld.university_id = ? AND ld.kind = ? LIMIT 1`,
    [universityId, kind],
  );
}

async function loadGlobalRow(
  db: D1Database,
  kind: LegalDocumentKind,
): Promise<LegalRowWithMeta | null> {
  return queryFirst<LegalRowWithMeta>(
    db,
    `${SELECT_BASE} WHERE ld.university_id IS NULL AND ld.kind = ? LIMIT 1`,
    [kind],
  );
}

interface ResolvedDocument {
  source: "customer" | "default";
  body_md: string;
  version: number;
  published_at: string;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  updated_at: string;
  university_id: string | null;
  university_name: string | null;
}

/**
 * The public read path. Returns whichever document is "in force" for
 * the given university — the per-customer override if set, the global
 * default if not, and the seeded boilerplate as a final fallback so
 * fresh deploys are never broken.
 */
async function resolveDocument(
  db: D1Database,
  kind: LegalDocumentKind,
  universityId: string | null,
): Promise<ResolvedDocument> {
  if (universityId) {
    const customer = await loadCustomerRow(db, universityId, kind);
    if (customer) {
      return {
        source: "customer",
        body_md: customer.body_md,
        version: customer.version,
        published_at: customer.published_at,
        updated_by_user_id: customer.updated_by_user_id,
        updated_by_name: customer.updated_by_name,
        updated_at: customer.updated_at,
        university_id: customer.university_id,
        university_name: customer.university_name,
      };
    }
  }
  const universityName = universityId
    ? await fetchUniversityName(db, universityId)
    : null;
  const global = await loadGlobalRow(db, kind);
  if (global) {
    return {
      source: "default",
      body_md: global.body_md,
      version: global.version,
      published_at: global.published_at,
      updated_by_user_id: global.updated_by_user_id,
      updated_by_name: global.updated_by_name,
      updated_at: global.updated_at,
      university_id: universityId,
      university_name: universityName,
    };
  }
  const now = new Date().toISOString();
  return {
    source: "default",
    body_md: defaultBodyForKind(kind),
    version: 1,
    published_at: now,
    updated_by_user_id: null,
    updated_by_name: null,
    updated_at: now,
    university_id: universityId,
    university_name: universityName,
  };
}

function contactEmailFor(env: Env): string | null {
  const v = env.SUPPORT_EMAIL?.trim();
  return v ? v : null;
}

function toPublicDoc(
  kind: LegalDocumentKind,
  resolved: ResolvedDocument,
  env: Env,
): LegalDocument {
  return {
    kind,
    version: resolved.version,
    body_md: renderLegalTemplate(resolved.body_md, {
      university_name: resolved.university_name,
      contact_email: contactEmailFor(env),
    }),
    published_at: resolved.published_at,
    university_id: resolved.university_id,
    university_name: resolved.university_name,
    source: resolved.source,
  };
}

// ---------------------------------------------------------------------------
// GET /api/legal/:kind
// ---------------------------------------------------------------------------

export async function handleGetLegalDocument(
  ctx: RequestContext,
  rawKind: string,
): Promise<Response> {
  const parsedKind = legalDocumentKindSchema.safeParse(rawKind);
  if (!parsedKind.success) {
    return errorResponse(404, "not_found", "Unknown legal document.");
  }
  const kind = parsedKind.data;

  // Optional university scoping. ?university_id=… is the simple case;
  // ?token=… resolves the invitation's university so the public accept
  // page shows the correct customer's text. We don't require either —
  // visitors hitting /privacy on the marketing site fall back to the
  // global default.
  const universityFromQuery = ctx.url.searchParams.get("university_id");
  const tokenFromQuery = ctx.url.searchParams.get("token");
  let universityId: string | null = universityFromQuery ?? null;

  if (!universityId && tokenFromQuery) {
    universityId = await universityIdForInvitationToken(
      ctx.env.DB,
      tokenFromQuery,
    );
  }

  const resolved = await resolveDocument(ctx.env.DB, kind, universityId);
  return jsonOk(toPublicDoc(kind, resolved, ctx.env));
}

async function universityIdForInvitationToken(
  db: D1Database,
  token: string,
): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const tokenHash = await hashInvitationToken(trimmed);
  const row = await queryFirst<{ university_id: string | null }>(
    db,
    `SELECT university_id FROM invitations WHERE token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  return row?.university_id ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/legal/acknowledgment-status
// ---------------------------------------------------------------------------

export async function handleGetAcknowledgmentStatus(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const universityId = actor.university_id ?? null;
  const universityName = await fetchUniversityName(ctx.env.DB, universityId);

  const [terms, privacy] = await Promise.all([
    resolveDocument(ctx.env.DB, "terms", universityId),
    resolveDocument(ctx.env.DB, "privacy", universityId),
  ]);

  const acceptedRow = await queryFirst<{
    terms_accepted_at: string | null;
    terms_accepted_version: number | null;
  }>(
    ctx.env.DB,
    `SELECT terms_accepted_at, terms_accepted_version
       FROM users WHERE id = ? LIMIT 1`,
    [actor.id],
  );
  const acceptedVersion = acceptedRow?.terms_accepted_version ?? null;
  const required =
    acceptedVersion === null || acceptedVersion < terms.version;

  const body: LegalAcknowledgmentStatus = {
    terms_required: required,
    current_terms_version: terms.version,
    current_privacy_version: privacy.version,
    accepted_terms_version: acceptedVersion,
    accepted_at: acceptedRow?.terms_accepted_at ?? null,
    university_id: universityId,
    university_name: universityName,
    contact_email: contactEmailFor(ctx.env),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/legal/accept
// ---------------------------------------------------------------------------

export async function handleAcceptLegal(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const raw = await readJson(ctx.request);
  const parsed = acceptLegalInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid acceptance payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const universityId = actor.university_id ?? null;
  const [terms, privacy] = await Promise.all([
    resolveDocument(ctx.env.DB, "terms", universityId),
    resolveDocument(ctx.env.DB, "privacy", universityId),
  ]);

  // Echoed-version mismatch is a soft conflict: a stale tab POSTing for
  // an old version. Refuse so the SPA reloads the gate before the user
  // accepts something they didn't actually see.
  if (
    parsed.data.terms_version !== terms.version ||
    parsed.data.privacy_version !== privacy.version
  ) {
    return errorResponse(
      409,
      "version_mismatch",
      "The Terms or Privacy Policy was updated. Please re-load the page and review the latest version.",
      {
        current_terms_version: terms.version,
        current_privacy_version: privacy.version,
      },
    );
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE users
        SET terms_accepted_at = ?,
            terms_accepted_version = ?,
            updated_at = ?
      WHERE id = ?`,
    [now, terms.version, now, actor.id],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "legal.terms_accepted",
    actorUserId: actor.id,
    universityId,
    entityType: "user",
    entityId: actor.id,
    metadata: {
      terms_version: terms.version,
      privacy_version: privacy.version,
      source: "in_app_gate",
    },
  });

  const body: LegalAcceptResponse = {
    accepted_terms_version: terms.version,
    accepted_privacy_version: privacy.version,
    accepted_at: now,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// GET /api/legal/admin
// ---------------------------------------------------------------------------

function resolveAdminTarget(actor: UserRow, requested: string | null): string | null | "forbidden" {
  if (actor.role === "super_admin") return requested ?? actor.university_id ?? null;
  if (actor.role === "university_admin") {
    if (!actor.university_id) return "forbidden";
    if (requested && requested !== actor.university_id) return "forbidden";
    return actor.university_id;
  }
  return "forbidden";
}

function toAdminDoc(
  kind: LegalDocumentKind,
  resolved: ResolvedDocument,
  raw: string,
): LegalAdminDocument {
  return {
    kind,
    version: resolved.version,
    body_md: raw,
    published_at: resolved.published_at,
    university_id: resolved.university_id,
    university_name: resolved.university_name,
    source: resolved.source,
    is_overridden: resolved.source === "customer",
    updated_by_user_id: resolved.updated_by_user_id,
    updated_by_name: resolved.updated_by_name,
    updated_at: resolved.updated_at,
  };
}

export async function handleGetLegalAdmin(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view legal documents.",
    );
  }

  const requested = ctx.url.searchParams.get("university_id");
  const target = resolveAdminTarget(actor, requested);
  if (target === "forbidden") {
    return errorResponse(
      403,
      "forbidden",
      "You can only manage legal documents for your own university.",
    );
  }

  const universityId = target;
  const universityName = await fetchUniversityName(ctx.env.DB, universityId);

  const [terms, privacy] = await Promise.all([
    resolveDocument(ctx.env.DB, "terms", universityId),
    resolveDocument(ctx.env.DB, "privacy", universityId),
  ]);

  const body: LegalAdminResponse = {
    university_id: universityId,
    university_name: universityName,
    contact_email: contactEmailFor(ctx.env),
    documents: {
      terms: toAdminDoc("terms", terms, terms.body_md),
      privacy: toAdminDoc("privacy", privacy, privacy.body_md),
    },
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// PUT /api/legal/admin/:kind
// ---------------------------------------------------------------------------

export async function handleUpdateLegalDocument(
  ctx: RequestContext,
  rawKind: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit legal documents.",
    );
  }

  const parsedKind = legalDocumentKindSchema.safeParse(rawKind);
  if (!parsedKind.success) {
    return errorResponse(404, "not_found", "Unknown legal document.");
  }
  const kind = parsedKind.data;

  const requested = ctx.url.searchParams.get("university_id");
  const target = resolveAdminTarget(actor, requested);
  if (target === "forbidden") {
    return errorResponse(
      403,
      "forbidden",
      "You can only manage legal documents for your own university.",
    );
  }
  // Only super_admin is allowed to edit the *global* default (university_id IS NULL).
  if (target === null && actor.role !== "super_admin") {
    return errorResponse(
      403,
      "forbidden",
      "Only super administrators can edit the global default.",
    );
  }

  const universityId = target;

  const raw = await readJson(ctx.request);
  const parsed = updateLegalDocumentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid document payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const existing = universityId
    ? await loadCustomerRow(ctx.env.DB, universityId, kind)
    : await loadGlobalRow(ctx.env.DB, kind);

  const now = new Date().toISOString();
  let resultingVersion: number;
  let bodyChanged: boolean;

  if (existing) {
    bodyChanged = existing.body_md !== parsed.data.body_md;
    resultingVersion = parsed.data.version_bump
      ? existing.version + 1
      : existing.version;
    await execute(
      ctx.env.DB,
      `UPDATE legal_documents
          SET body_md = ?,
              version = ?,
              published_at = CASE WHEN ? > version THEN ? ELSE published_at END,
              updated_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        parsed.data.body_md,
        resultingVersion,
        resultingVersion,
        now,
        actor.id,
        now,
        existing.id,
      ],
    );
  } else {
    bodyChanged = true;
    resultingVersion = 1;
    await execute(
      ctx.env.DB,
      `INSERT INTO legal_documents
         (id, university_id, kind, version, body_md, published_at,
          updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        universityId,
        kind,
        resultingVersion,
        parsed.data.body_md,
        now,
        actor.id,
        now,
        now,
      ],
    );
  }

  await writeAuditLog(ctx.env.DB, {
    action: "legal.document_updated",
    actorUserId: actor.id,
    universityId,
    entityType: "legal_document",
    entityId: existing?.id ?? null,
    metadata: {
      kind,
      version: resultingVersion,
      version_bumped: parsed.data.version_bump === true,
      body_changed: bodyChanged,
      scope: universityId ? "customer" : "global_default",
    },
  });

  const refreshed = await resolveDocument(ctx.env.DB, kind, universityId);
  const body = toAdminDoc(kind, refreshed, refreshed.body_md);
  return jsonOk(body);
}
