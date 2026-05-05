// FERPA disclosure-log routes (epic UNI-21 / sub-issue UNI-32).
//
//   GET  /api/disclosures   list (super_admin / university_admin only)
//   POST /api/disclosures   record a release
//
// FERPA §99.32 requires institutions to keep a record of every disclosure of
// education records to a third party. We refuse to record a disclosure
// without a referenced, non-revoked, non-expired consent — that is the gate
// the acceptance criteria asks us to enforce.

import {
  DISCLOSURE_DATA_CATEGORIES,
  recordDisclosureInputSchema,
  type DisclosureBasis,
  type DisclosureDataCategory,
  type DisclosureLogEntry,
  type DisclosureLogListItem,
  type DisclosureLogListResponse,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

type LogRow = Row & {
  id: string;
  student_user_id: string;
  university_id: string | null;
  consent_id: string | null;
  basis: DisclosureBasis;
  released_to: string;
  data_categories: string;
  notes: string | null;
  released_at: string;
  released_by_user_id: string | null;
  student_name: string | null;
  student_email: string | null;
  student_university_id: string | null;
  released_by_name: string | null;
  consent_requester: string | null;
  consent_purpose: string | null;
};

type ConsentRow = Row & {
  id: string;
  student_user_id: string;
  university_id: string | null;
  data_categories: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type CountRow = Row & { c: number };

const SELECT_BASE = `
  SELECT dl.id, dl.student_user_id, dl.university_id, dl.consent_id, dl.basis,
         dl.released_to, dl.data_categories, dl.notes,
         dl.released_at, dl.released_by_user_id,
         u.name AS student_name, u.email AS student_email,
         u.university_id AS student_university_id,
         r.name AS released_by_name,
         dc.requester AS consent_requester,
         dc.purpose   AS consent_purpose
    FROM disclosure_log dl
    LEFT JOIN users u ON u.id = dl.student_user_id
    LEFT JOIN users r ON r.id = dl.released_by_user_id
    LEFT JOIN disclosure_consents dc ON dc.id = dl.consent_id
`;

const SELECT_COUNT = `
  SELECT COUNT(1) AS c
    FROM disclosure_log dl
    LEFT JOIN users u ON u.id = dl.student_user_id
`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

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

function toListItem(row: LogRow): DisclosureLogListItem {
  return {
    id: row.id,
    student_user_id: row.student_user_id,
    university_id: row.university_id,
    consent_id: row.consent_id,
    basis: row.basis,
    released_to: row.released_to,
    data_categories: parseCategories(row.data_categories),
    notes: row.notes,
    released_at: row.released_at,
    released_by_user_id: row.released_by_user_id,
    student_name: row.student_name,
    student_email: row.student_email,
    released_by_name: row.released_by_name,
    consent_requester: row.consent_requester,
    consent_purpose: row.consent_purpose,
  };
}

function toApi(row: LogRow): DisclosureLogEntry {
  return {
    id: row.id,
    student_user_id: row.student_user_id,
    university_id: row.university_id,
    consent_id: row.consent_id,
    basis: row.basis,
    released_to: row.released_to,
    data_categories: parseCategories(row.data_categories),
    notes: row.notes,
    released_at: row.released_at,
    released_by_user_id: row.released_by_user_id,
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
// GET /api/disclosures
// ---------------------------------------------------------------------------

export async function handleListDisclosures(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (actor.role !== "super_admin" && actor.role !== "university_admin") {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view the disclosure log.",
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.role === "university_admin") {
    if (!actor.university_id) {
      return jsonOk<DisclosureLogListResponse>({
        items: [],
        total: 0,
        limit: DEFAULT_LIMIT,
        offset: 0,
        has_more: false,
      });
    }
    where.push("(dl.university_id = ? OR u.university_id = ?)");
    params.push(actor.university_id, actor.university_id);
  } else {
    const universityId = ctx.url.searchParams.get("university_id");
    if (universityId) {
      where.push("(dl.university_id = ? OR u.university_id = ?)");
      params.push(universityId, universityId);
    }
  }

  const studentId = ctx.url.searchParams.get("student_user_id");
  if (studentId) {
    where.push("dl.student_user_id = ?");
    params.push(studentId);
  }
  const consentId = ctx.url.searchParams.get("consent_id");
  if (consentId) {
    where.push("dl.consent_id = ?");
    params.push(consentId);
  }
  const from = ctx.url.searchParams.get("from");
  if (from) {
    where.push("dl.released_at >= ?");
    params.push(from);
  }
  const to = ctx.url.searchParams.get("to");
  if (to) {
    where.push("dl.released_at <= ?");
    params.push(to);
  }

  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  const offset = parseOffset(ctx.url.searchParams.get("offset"));

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const listSql =
    SELECT_BASE +
    whereSql +
    " ORDER BY dl.released_at DESC LIMIT ? OFFSET ?";
  const countSql = SELECT_COUNT + whereSql;

  const [rows, countRow] = await Promise.all([
    queryAll<LogRow>(ctx.env.DB, listSql, [...params, limit, offset]),
    queryFirst<CountRow>(ctx.env.DB, countSql, params),
  ]);
  const total = Number(countRow?.c ?? 0);

  const body: DisclosureLogListResponse = {
    items: rows.map(toListItem),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// POST /api/disclosures
// ---------------------------------------------------------------------------

export async function handleRecordDisclosure(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Recording a disclosure is an institutional action — staff can do it too,
  // but the listing surface is admin-only. Limit writes to the same set as
  // the FERPA admin pages.
  if (actor.role !== "super_admin" && actor.role !== "university_admin") {
    return errorResponse(
      403,
      "forbidden",
      "Only super_admin or university_admin may record a disclosure.",
    );
  }

  const raw = await readJson(ctx.request);
  const parsed = recordDisclosureInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Invalid disclosure payload.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const consent = await queryFirst<ConsentRow>(
    ctx.env.DB,
    `SELECT id, student_user_id, university_id, data_categories, expires_at, revoked_at
       FROM disclosure_consents
       WHERE id = ? LIMIT 1`,
    [parsed.data.consent_id],
  );
  if (!consent) {
    return errorResponse(
      400,
      "consent_required",
      "A disclosure must reference an existing consent.",
    );
  }
  if (consent.revoked_at) {
    return errorResponse(
      400,
      "consent_revoked",
      "Cannot release records under a revoked consent.",
    );
  }
  if (consent.expires_at && Date.parse(consent.expires_at) < Date.now()) {
    return errorResponse(
      400,
      "consent_expired",
      "Cannot release records under an expired consent.",
    );
  }

  // university_admin must stay in their own university even when recording
  // a release that nominally belongs to another uni's student.
  if (
    actor.role === "university_admin" &&
    actor.university_id !== null &&
    consent.university_id !== null &&
    consent.university_id !== actor.university_id
  ) {
    return errorResponse(
      403,
      "forbidden",
      "You can only record disclosures for students in your university.",
    );
  }

  // The release categories must be a subset of what the consent covers.
  const consentCategories = new Set(parseCategories(consent.data_categories));
  for (const c of parsed.data.data_categories) {
    if (!consentCategories.has(c)) {
      return errorResponse(
        400,
        "categories_outside_consent",
        `The consent does not cover category "${c}".`,
      );
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const categoriesJson = JSON.stringify(parsed.data.data_categories);
  await execute(
    ctx.env.DB,
    `INSERT INTO disclosure_log
       (id, student_user_id, university_id, consent_id, released_to,
        data_categories, notes, released_at, released_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      consent.student_user_id,
      consent.university_id,
      consent.id,
      parsed.data.released_to,
      categoriesJson,
      parsed.data.notes ?? null,
      now,
      actor.id,
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "disclosure.released",
    actorUserId: actor.id,
    universityId: consent.university_id,
    entityType: "disclosure",
    entityId: id,
    metadata: {
      student_user_id: consent.student_user_id,
      consent_id: consent.id,
      released_to: parsed.data.released_to,
      data_categories: parsed.data.data_categories,
      actor_role: actor.role,
    },
  });

  const row = await queryFirst<LogRow>(
    ctx.env.DB,
    `${SELECT_BASE} WHERE dl.id = ? LIMIT 1`,
    [id],
  );
  if (!row) {
    return errorResponse(500, "create_failed", "Could not record disclosure.");
  }
  return jsonOk(toApi(row), { status: 201 });
}
