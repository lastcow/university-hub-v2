// Escalation-contact admin surface (epic UNI-21 / sub-issue UNI-40).
//
//   GET   /api/escalation-contacts             super_admin / university_admin —
//                                              full table for the runbook +
//                                              admin UI.
//   PATCH /api/escalation-contacts/:role_key   super_admin only — edit one
//                                              row's contact details.
//
// Read is open to both admin tiers because the breach-response runbook
// (`docs/incident-response.md`) calls the in-app table as the source of
// truth — `university_admin` needs to consult it during an incident.
// Edits are super_admin-only per the UNI-40 spec ("admin-only page,
// super_admin role"); a customer's `university_admin` should not be able
// to silently rewrite the SaaS operator's on-call entry.
//
// Single-tenant per deploy: there's exactly one row per `role_key`, so we
// don't carry `university_id` here. Edits are audit-logged
// (`escalation.contact_updated`) and the `actor`'s `university_id` is
// recorded on the audit row so multi-customer log analysis still works.

import {
  ESCALATION_CONTACT_ROLE_KEYS,
  escalationContactRoleKeySchema,
  updateEscalationContactInputSchema,
  type EscalationContact,
  type EscalationContactRoleKey,
  type EscalationContactsResponse,
} from "@university-hub/shared";

import type { UserRow } from "../auth/session.js";
import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

interface EscalationContactRow extends Row {
  role_key: EscalationContactRoleKey;
  role_label: string;
  display_order: number;
  person_name: string;
  email: string;
  phone: string;
  notes: string;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  updated_at: string;
}

const SELECT_BASE = `
  SELECT ec.role_key, ec.role_label, ec.display_order,
         ec.person_name, ec.email, ec.phone, ec.notes,
         ec.updated_by_user_id, ec.updated_at,
         u.name AS updated_by_name
    FROM escalation_contacts ec
    LEFT JOIN users u ON u.id = ec.updated_by_user_id
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
 * Mockup-vs-real check: we seeded the table with RFC 2606 reserved-domain
 * emails (`*@example.com` / `*@example.edu`) and the +1-555-01xx fictional
 * phone range. Either signal flags the row as still-mockup; the runbook
 * treats those rows as a launch blocker.
 */
const MOCKUP_EMAIL_RE = /@(?:[\w.-]+\.)?example\.(?:com|edu|net|org)$/i;
const MOCKUP_PHONE_RE = /\+?1[-\s.]?\(?555\)?[-\s.]?01\d{2}/;

export function isMockupContact(row: {
  email: string;
  phone: string;
}): boolean {
  return MOCKUP_EMAIL_RE.test(row.email) || MOCKUP_PHONE_RE.test(row.phone);
}

function rowToContact(row: EscalationContactRow): EscalationContact {
  return {
    role_key: row.role_key,
    role_label: row.role_label,
    display_order: row.display_order,
    person_name: row.person_name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    is_mockup: isMockupContact(row),
    updated_by_user_id: row.updated_by_user_id,
    updated_by_name: row.updated_by_name,
    updated_at: row.updated_at,
  };
}

async function loadAllContacts(
  db: D1Database,
): Promise<EscalationContactRow[]> {
  return queryAll<EscalationContactRow>(
    db,
    `${SELECT_BASE} ORDER BY ec.display_order ASC`,
  );
}

async function loadContactByKey(
  db: D1Database,
  key: EscalationContactRoleKey,
): Promise<EscalationContactRow | null> {
  return queryFirst<EscalationContactRow>(
    db,
    `${SELECT_BASE} WHERE ec.role_key = ? LIMIT 1`,
    [key],
  );
}

// ---------------------------------------------------------------------------
// GET /api/escalation-contacts
// ---------------------------------------------------------------------------

export async function handleListEscalationContacts(
  ctx: RequestContext,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (!isAdminLike(actor)) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to view escalation contacts.",
    );
  }

  const rows = await loadAllContacts(ctx.env.DB);
  const contacts = rows.map(rowToContact);
  // Defense-in-depth: if the seed failed for some reason, surface every
  // missing role as a synthetic "blank" mockup row so the runbook + UI
  // still shows the slot rather than silently dropping it. This should
  // never happen in a freshly-migrated deploy but is cheap to guard.
  const present = new Set(contacts.map((c) => c.role_key));
  const synthetic: EscalationContact[] = ESCALATION_CONTACT_ROLE_KEYS
    .filter((k) => !present.has(k))
    .map((k, i) => ({
      role_key: k,
      role_label: k,
      display_order: 1_000 + i,
      person_name: "(missing)",
      email: "(missing)@example.com",
      phone: "+1-555-0100",
      notes: "Row missing — re-run migration 0011 or seed the table.",
      is_mockup: true,
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: new Date(0).toISOString(),
    }));
  const all = [...contacts, ...synthetic].sort(
    (a, b) => a.display_order - b.display_order,
  );

  const body: EscalationContactsResponse = {
    contacts: all,
    any_mockup: all.some((c) => c.is_mockup),
  };
  return jsonOk(body);
}

// ---------------------------------------------------------------------------
// PATCH /api/escalation-contacts/:role_key
// ---------------------------------------------------------------------------

export async function handleUpdateEscalationContact(
  ctx: RequestContext,
  rawKey: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;
  if (actor.role !== "super_admin") {
    return errorResponse(
      403,
      "forbidden",
      "Only super administrators can edit escalation contacts.",
    );
  }

  const parsedKey = escalationContactRoleKeySchema.safeParse(rawKey);
  if (!parsedKey.success) {
    return errorResponse(404, "not_found", "Unknown escalation role.");
  }
  const roleKey = parsedKey.data;

  const raw = await readJson(ctx.request);
  const parsed = updateEscalationContactInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid escalation-contact payload.",
      { issues: parsed.error.flatten().fieldErrors },
    );
  }

  const existing = await loadContactByKey(ctx.env.DB, roleKey);
  if (!existing) {
    // The seeded migration creates all six rows; a missing row means the
    // migration didn't run. Report cleanly rather than silently INSERTing
    // since we'd lose the schema-level CHECK constraint coverage.
    return errorResponse(
      404,
      "not_found",
      "Escalation-contact row is missing — re-run migration 0011.",
    );
  }

  const wasMockup = isMockupContact({
    email: existing.email,
    phone: existing.phone,
  });
  const stillMockup = isMockupContact({
    email: parsed.data.email,
    phone: parsed.data.phone,
  });

  const now = new Date().toISOString();
  await execute(
    ctx.env.DB,
    `UPDATE escalation_contacts
        SET role_label = ?,
            person_name = ?,
            email = ?,
            phone = ?,
            notes = ?,
            updated_by_user_id = ?,
            updated_at = ?
      WHERE role_key = ?`,
    [
      parsed.data.role_label,
      parsed.data.person_name,
      parsed.data.email,
      parsed.data.phone,
      parsed.data.notes,
      actor.id,
      now,
      roleKey,
    ],
  );

  await writeAuditLog(ctx.env.DB, {
    action: "escalation.contact_updated",
    actorUserId: actor.id,
    universityId: actor.university_id ?? null,
    entityType: "escalation_contact",
    entityId: roleKey,
    metadata: {
      role_key: roleKey,
      role_label: parsed.data.role_label,
      // Don't echo the full new email + phone into the audit row — those
      // are PII that the audit-logs UI exposes to admins. Capturing the
      // mockup-vs-real transition is the FERPA-relevant signal.
      was_mockup: wasMockup,
      is_mockup: stillMockup,
      transitioned_to_real: wasMockup && !stillMockup,
    },
  });

  const refreshed = await loadContactByKey(ctx.env.DB, roleKey);
  if (!refreshed) {
    return errorResponse(
      500,
      "internal_error",
      "Updated row vanished after write.",
    );
  }
  return jsonOk(rowToContact(refreshed));
}
