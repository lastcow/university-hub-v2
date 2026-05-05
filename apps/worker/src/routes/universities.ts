// Universities CRUD endpoints (epic UNI-1 §9, §17, §28; UNI-58 §B).
//
//   GET   /api/universities          list (super_admin: all; others: own)
//   POST  /api/universities          locked: returns 409 single_tenant_deploy.
//                                    New university deploys are provisioned
//                                    via scripts/provision-university.mjs;
//                                    the platform is single-tenant per
//                                    Worker, so creating a second row is
//                                    always an orphan-write footgun.
//   GET   /api/universities/:id      detail (scoped)
//   PATCH /api/universities/:id      update (super_admin or that university's admin)
//
// All writes audit-log via `university.created` / `university.updated`. Slug
// uniqueness is enforced by the DB (UNIQUE constraint) and surfaced as a 409.

import {
  updateUniversityInputSchema,
  type University,
  type UniversityStatus,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import type { UserRow } from "../auth/session.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// Single-tenant deploy hint surfaced via POST /api/universities. Kept as
// a constant so tests + the SPA can pin against the same string.
export const SINGLE_TENANT_PROVISION_HINT =
  "Use scripts/provision-university.mjs to create new university deploys.";

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

function isWithinScope(actor: UserRow, universityId: string | null): boolean {
  if (actor.role === "super_admin") return true;
  if (universityId === null) return false;
  return actor.university_id === universityId;
}

/** Whether the actor may edit the given university. */
function canEditUniversity(actor: UserRow, universityId: string): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "university_admin") return actor.university_id === universityId;
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/universities
// ---------------------------------------------------------------------------

export async function handleListUniversities(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Super admin: see everything. Anyone else: see only their own university,
  // and only if they have one. Unaffiliated non-admins get an empty list.
  if (actor.role === "super_admin") {
    const rows = await queryAll<UniversityRow>(
      ctx.env.DB,
      `${SELECT_UNIVERSITY} ORDER BY name ASC LIMIT 200`,
    );
    return jsonOk(rows.map(toUniversity));
  }

  if (!actor.university_id) return jsonOk([]);
  const rows = await queryAll<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [actor.university_id],
  );
  return jsonOk(rows.map(toUniversity));
}

// ---------------------------------------------------------------------------
// POST /api/universities
//
// Permanently locked. Creating a university row at runtime always
// produces an orphan deploy (no Worker, no Pages project, no D1
// database) so we close the door on the UI flow and route every
// caller — including super_admin — to the per-customer provision
// script. The endpoint stays mounted so a stale client gets a clean
// 409 with a hint instead of a generic 404.
// ---------------------------------------------------------------------------

export async function handleCreateUniversity(ctx: RequestContext): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;

  return errorResponse(
    409,
    "single_tenant_deploy",
    "Creating universities from the API is disabled in this single-tenant deploy.",
    { hint: SINGLE_TENANT_PROVISION_HINT },
  );
}

// ---------------------------------------------------------------------------
// GET /api/universities/:id
// ---------------------------------------------------------------------------

export async function handleGetUniversity(
  ctx: RequestContext,
  universityId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [universityId],
  );
  if (!row) return errorResponse(404, "not_found", "University not found.");
  if (!isWithinScope(actor, row.id)) {
    return errorResponse(404, "not_found", "University not found.");
  }
  return jsonOk(toUniversity(row));
}

// ---------------------------------------------------------------------------
// PATCH /api/universities/:id
// ---------------------------------------------------------------------------

export async function handleUpdateUniversity(
  ctx: RequestContext,
  universityId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const existing = await queryFirst<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [universityId],
  );
  if (!existing) return errorResponse(404, "not_found", "University not found.");

  if (!canEditUniversity(actor, universityId)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to edit this university.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = updateUniversityInputSchema.safeParse(raw);
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
        [parsed.data.slug, universityId],
      );
      if (collision) {
        return errorResponse(409, "slug_taken", "That slug is already in use.");
      }
    }
    updates.push("slug = ?");
    params.push(parsed.data.slug);
    changed.slug = parsed.data.slug;
  }
  if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
    updates.push("status = ?");
    params.push(parsed.data.status);
    changed.status = parsed.data.status;
  }

  if (updates.length === 0) {
    return jsonOk(toUniversity(existing));
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(universityId);

  await execute(
    ctx.env.DB,
    `UPDATE universities SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  await writeAuditLog(ctx.env.DB, {
    action: "university.updated",
    actorUserId: actor.id,
    universityId,
    entityType: "university",
    entityId: universityId,
    metadata: { changed },
  });

  const refreshed = await queryFirst<UniversityRow>(
    ctx.env.DB,
    `${SELECT_UNIVERSITY} WHERE id = ? LIMIT 1`,
    [universityId],
  );
  return jsonOk(refreshed ? toUniversity(refreshed) : toUniversity(existing));
}
