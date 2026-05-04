// FERPA written-consent routes (epic UNI-21 / sub-issue UNI-32).
//
//   GET   /api/disclosure-consents                list (filtered + scoped)
//   POST  /api/disclosure-consents                grant a new consent
//   POST  /api/disclosure-consents/:id/revoke     revoke an existing consent
//
// Authorisation matrix:
//   - super_admin: any student.
//   - university_admin / staff: students in their university.
//   - student (over 18): their own consents.
//   - student (under 18): NOT allowed — must go through the parent flow,
//     which has its own routes file (`routes/parent-flag.ts`).
//
// Every grant + revoke writes an `audit_logs` row. Consents are append-only
// with a tombstone (`revoked_at`) — we never DELETE.

import {
  AUDIT_ACTIONS,
  DISCLOSURE_DATA_CATEGORIES,
  createDisclosureConsentInputSchema,
  type AuditAction,
  type DisclosureConsent,
  type DisclosureConsentListItem,
  type DisclosureDataCategory,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type ConsentRow = Row & {
  id: string;
  student_user_id: string;
  university_id: string | null;
  requester: string;
  purpose: string;
  data_categories: string;
  granted_at: string;
  granted_by_user_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  student_name: string | null;
  student_email: string | null;
  student_university_id: string | null;
  granted_by_name: string | null;
};

const SELECT_BASE = `
  SELECT dc.id, dc.student_user_id, dc.university_id, dc.requester, dc.purpose,
         dc.data_categories, dc.granted_at, dc.granted_by_user_id,
         dc.expires_at, dc.revoked_at, dc.revoked_by_user_id,
         dc.created_at, dc.updated_at,
         u.name AS student_name, u.email AS student_email,
         u.university_id AS student_university_id,
         g.name AS granted_by_name
    FROM disclosure_consents dc
    LEFT JOIN users u ON u.id = dc.student_user_id
    LEFT JOIN users g ON g.id = dc.granted_by_user_id
`;

function parseCategories(raw: string): DisclosureDataCategory[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is DisclosureDataCategory =>
        typeof c === "string" &&
        (DISCLOSURE_DATA_CATEGORIES as readonly string[]).includes(c),
    );
  } catch {
    return [];
  }
}

function isActive(row: ConsentRow, now: number): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && Date.parse(row.expires_at) < now) return false;
  return true;
}

function toListItem(row: ConsentRow, now: number): DisclosureConsentListItem {
  return {
    id: row.id,
    student_user_id: row.student_user_id,
    university_id: row.university_id,
    requester: row.requester,
    purpose: row.purpose,
    data_categories: parseCategories(row.data_categories),
    granted_at: row.granted_at,
    granted_by_user_id: row.granted_by_user_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_by_user_id: row.revoked_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    student_name: row.student_name,
    student_email: row.student_email,
    granted_by_name: row.granted_by_name,
    active: isActive(row, now),
  };
}

function toApi(row: ConsentRow): DisclosureConsent {
  return {
    id: row.id,
    student_user_id: row.student_user_id,
    university_id: row.university_id,
    requester: row.requester,
    purpose: row.purpose,
    data_categories: parseCategories(row.data_categories),
    granted_at: row.granted_at,
    granted_by_user_id: row.granted_by_user_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_by_user_id: row.revoked_by_user_id,
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

function isAdminLike(actor: UserRow): boolean {
  return (
    actor.role === "super_admin" ||
    actor.role === "university_admin" ||
    actor.role === "staff"
  );
}

interface StudentLookupRow {
  id: string;
  role: string;
  university_id: string | null;
  under_18: number | null;
}

async function loadStudentByUserId(
  db: D1Database,
  userId: string,
): Promise<StudentLookupRow | null> {
  return queryFirst<StudentLookupRow & Row>(
    db,
    `SELECT u.id AS id, u.role AS role, u.university_id AS university_id,
            s.under_18 AS under_18
       FROM users u
       LEFT JOIN students s ON s.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// GET /api/disclosure-consents
// ---------------------------------------------------------------------------

export async function handleListDisclosureConsents(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "super_admin") {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("(dc.university_id = ? OR u.university_id = ?)");
      params.push(universityId, universityId);
    }
  } else if (actor.role === "university_admin" || actor.role === "staff") {
    if (!actor.university_id) {
      return jsonOk<DisclosureConsentListItem[]>([]);
    }
    where.push("(dc.university_id = ? OR u.university_id = ?)");
    params.push(actor.university_id, actor.university_id);
  } else if (actor.role === "student") {
    where.push("dc.student_user_id = ?");
    params.push(actor.id);
  } else {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view disclosure consents.",
    );
  }

  const studentFilter = ctx.url.searchParams.get("student_user_id");
  if (studentFilter) {
    if (
      actor.role === "student" &&
      studentFilter !== actor.id
    ) {
      return errorResponse(
        403,
        "forbidden",
        "Students may only view their own disclosure consents.",
      );
    }
    where.push("dc.student_user_id = ?");
    params.push(studentFilter);
  }

  const sql =
    SELECT_BASE +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY dc.granted_at DESC LIMIT 200";

  const rows = await queryAll<ConsentRow>(ctx.env.DB, sql, params);
  const now = Date.now();
  return jsonOk(rows.map((r) => toListItem(r, now)));
}

// ---------------------------------------------------------------------------
// POST /api/disclosure-consents
// ---------------------------------------------------------------------------

export async function handleCreateDisclosureConsent(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const raw = await readJson(ctx.request);
  const parsed = createDisclosureConsentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid consent payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const target = await loadStudentByUserId(
    ctx.env.DB,
    parsed.data.student_user_id,
  );
  if (!target || target.role !== "student") {
    return errorResponse(404, "not_found", "Student not found.");
  }

  const isSelf = target.id === actor.id;
  const adminLike = isAdminLike(actor);
  const adminInScope =
    actor.role === "super_admin" ||
    (adminLike && actor.university_id === target.university_id);

  if (isSelf) {
    if (Boolean(target.under_18)) {
      return errorResponse(
        403,
        "under_18_self_blocked",
        "Under-18 students cannot grant consent themselves; this must be done by a parent or guardian, or recorded by a school administrator.",
      );
    }
  } else if (!adminInScope) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to grant consent on this student's behalf.",
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const categoriesJson = JSON.stringify(parsed.data.data_categories);
  await execute(
    ctx.env.DB,
    `INSERT INTO disclosure_consents
       (id, student_user_id, university_id, requester, purpose, data_categories,
        granted_at, granted_by_user_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      target.id,
      target.university_id,
      parsed.data.requester,
      parsed.data.purpose,
      categoriesJson,
      now,
      actor.id,
      parsed.data.expires_at ?? null,
      now,
      now,
    ],
  );

  const grantAction: AuditAction = "disclosure_consent.granted";
  // The audit-action enum is the source of truth — if the constant ever drops
  // this action, this assertion fires at compile time. The cheap runtime
  // check is defense-in-depth for a future refactor.
  if (!(AUDIT_ACTIONS as readonly string[]).includes(grantAction)) {
    throw new Error(`Unknown audit action: ${grantAction}`);
  }

  await writeAuditLog(ctx.env.DB, {
    action: grantAction,
    actorUserId: actor.id,
    universityId: target.university_id,
    entityType: "disclosure_consent",
    entityId: id,
    metadata: {
      student_user_id: target.id,
      requester: parsed.data.requester,
      purpose: parsed.data.purpose,
      data_categories: parsed.data.data_categories,
      expires_at: parsed.data.expires_at ?? null,
      actor_role: actor.role,
    },
  });

  const row = await queryFirst<ConsentRow>(
    ctx.env.DB,
    `${SELECT_BASE} WHERE dc.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not record consent.");
  }
  return jsonOk(toApi(row), { status: 201 });
}

// ---------------------------------------------------------------------------
// POST /api/disclosure-consents/:id/revoke
// ---------------------------------------------------------------------------

export async function handleRevokeDisclosureConsent(
  ctx: RequestContext,
  consentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  const row = await queryFirst<ConsentRow>(
    ctx.env.DB,
    `${SELECT_BASE} WHERE dc.id = ? LIMIT 1`,
    [consentId],
  );
  if (!row) {
    return errorResponse(404, "not_found", "Consent not found.");
  }

  const isSelf = row.student_user_id === actor.id;
  const adminLike = isAdminLike(actor);
  const targetUniversity = row.university_id ?? row.student_university_id;
  const adminInScope =
    actor.role === "super_admin" ||
    (adminLike && actor.university_id === targetUniversity);
  if (!isSelf && !adminInScope) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to revoke this consent.",
    );
  }

  if (row.revoked_at) {
    // Idempotent — already revoked. Don't audit again.
    return jsonOk(toApi(row));
  }

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE disclosure_consents
       SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    [now, actor.id, now, consentId],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "disclosure_consent.revoked",
    actorUserId: actor.id,
    universityId: targetUniversity,
    entityType: "disclosure_consent",
    entityId: consentId,
    metadata: {
      student_user_id: row.student_user_id,
      requester: row.requester,
      actor_role: actor.role,
    },
  });

  const updated = await queryFirst<ConsentRow>(
    ctx.env.DB,
    `${SELECT_BASE} WHERE dc.id = ? LIMIT 1`,
    [consentId],
  );
  return jsonOk(toApi(updated ?? row));
}
