// Route tests for the escalation-contacts admin surface (UNI-40).
//
// Coverage map back to the issue acceptance criteria:
//
//   - "D1 migration adds the contacts table; six rows seeded with mockup
//     data."  → covered by the seeded fixture used in every test below
//      (the migration itself runs against real D1; we pin the seed shape
//      here so a regression in the row count or role_keys would surface).
//
//   - "Admin UI route exists, gated to super_admin, and round-trips edits
//     via the Worker API."  → see "GET — RBAC" + "PATCH — RBAC" describe
//      blocks (super_admin allowed, university_admin forbidden on PATCH,
//      others forbidden on both).
//
//   - "Audit log records edits."  → see "PATCH — audit + mockup signal".
//
//   - "Tests cover: read, edit, non-admin-rejected, audit entry written."
//     → all four below.
//
// Mockup-vs-real check: the runbook keys off `*@example.*` emails or
// +1-555-01xx phone numbers. Tests assert both signals individually and
// the mockup→real transition recorded in the audit row.

import { describe, expect, it } from "vitest";

import { ESCALATION_CONTACT_ROLE_KEYS } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleListEscalationContacts,
  handleUpdateEscalationContact,
} from "../../src/routes/escalation-contacts.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const STUDENT_ID = "00000000-0000-0000-0000-00000000cccc";
const UNI_A = "11111111-1111-1111-1111-111111111111";

interface ContactRow {
  role_key: string;
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

const NOW = "2026-05-04T20:00:00.000Z";

function seedMockupRows(): ContactRow[] {
  return [
    {
      role_key: "operator_oncall",
      role_label: "SaaS operator on-call lead",
      display_order: 1,
      person_name: "Jordan Reyes",
      email: "jordan.reyes@universityhub.example.com",
      phone: "+1-555-0142",
      notes: "First responder.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
    {
      role_key: "customer_dpo",
      role_label: "Customer DPO / privacy officer",
      display_order: 2,
      person_name: "Dr. Sam Patel",
      email: "dpo@stanton.example.edu",
      phone: "+1-555-0188",
      notes: "FERPA notifications.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
    {
      role_key: "customer_ferpa_officer",
      role_label: "Customer FERPA officer",
      display_order: 3,
      person_name: "Dr. Sam Patel",
      email: "ferpa@stanton.example.edu",
      phone: "+1-555-0188",
      notes: "Issues student notifications.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
    {
      role_key: "customer_it_lead",
      role_label: "Customer IT / security lead",
      display_order: 4,
      person_name: "Alex Nakamura",
      email: "ciso@stanton.example.edu",
      phone: "+1-555-0191",
      notes: "Day-of technical counterpart.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
    {
      role_key: "customer_general_counsel",
      role_label: "Customer General Counsel",
      display_order: 5,
      person_name: "Marisol Greene",
      email: "counsel@stanton.example.edu",
      phone: "+1-555-0205",
      notes: "Litigation hold.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
    {
      role_key: "customer_ceo",
      role_label: "Customer CEO / executive sponsor",
      display_order: 6,
      person_name: "Dr. Eleanor Whitaker",
      email: "president@stanton.example.edu",
      phone: "+1-555-0173",
      notes: "Final-call escalation.",
      updated_by_user_id: null,
      updated_by_name: null,
      updated_at: NOW,
    },
  ];
}

function makeDb(seed: ContactRow[] = seedMockupRows()): ProgrammableD1 {
  const db = new ProgrammableD1();
  const rows = seed.map((r) => ({ ...r }));

  db.onFirst((sql, params) => {
    if (sql.startsWith("PRAGMA")) return null;
    if (sql.startsWith("SELECT ec.role_key")) {
      // Per-key fetch (LIMIT 1) — only matches when WHERE role_key = ?.
      if (sql.includes("WHERE ec.role_key = ?")) {
        const [key] = params as [string];
        return rows.find((r) => r.role_key === key) ?? null;
      }
    }
    return undefined;
  });

  db.onAll((sql) => {
    if (sql.startsWith("SELECT ec.role_key") && sql.includes("ORDER BY")) {
      return [...rows].sort((a, b) => a.display_order - b.display_order);
    }
    return undefined;
  });

  db.onWrite((sql, params) => {
    if (sql.startsWith("UPDATE escalation_contacts")) {
      const [
        role_label,
        person_name,
        email,
        phone,
        notes,
        updated_by_user_id,
        updated_at,
        role_key,
      ] = params as [string, string, string, string, string, string, string, string];
      const row = rows.find((r) => r.role_key === role_key);
      if (row) {
        row.role_label = role_label;
        row.person_name = person_name;
        row.email = email;
        row.phone = phone;
        row.notes = notes;
        row.updated_by_user_id = updated_by_user_id;
        row.updated_at = updated_at;
      }
    }
  });

  return db;
}

const ENV: Env = {
  DB: undefined as unknown as D1Database,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
} as Env;

function ctxWith(
  db: ProgrammableD1,
  actor:
    | (Partial<UserRow> & Pick<UserRow, "id" | "role">)
    | null,
  init?: { method?: string; body?: unknown; path?: string },
): RequestContext {
  const url = new URL(
    `https://hub.example.com${init?.path ?? "/api/escalation-contacts"}`,
  );
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  const auth: AuthState | null = actor
    ? {
        user: {
          id: actor.id,
          email: actor.email ?? "user@example.com",
          name: actor.name ?? "User",
          role: actor.role,
          status: actor.status ?? "active",
          university_id: actor.university_id ?? null,
          password_hash: actor.password_hash ?? "x",
          last_sign_in_at: null,
          created_at: "2026",
          updated_at: "2026",
        } as UserRow,
        session: {
          id: "s",
          user_id: actor.id,
          token_hash: "h",
          ip_address: null,
          user_agent: null,
          expires_at: "2099",
          created_at: "2026",
          last_activity_at: "2026",
        },
      }
    : null;
  return {
    request: new Request(url, requestInit),
    env: { ...ENV, DB: db as unknown as D1Database },
    url,
    cookies: {},
    auth,
  };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// GET — RBAC
// ---------------------------------------------------------------------------

describe("GET /api/escalation-contacts — RBAC", () => {
  it("requires authentication", async () => {
    const res = await handleListEscalationContacts(ctxWith(makeDb(), null));
    expect(res.status).toBe(401);
  });

  it("rejects students (403)", async () => {
    const res = await handleListEscalationContacts(
      ctxWith(makeDb(), {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns the seeded six rows for super_admin, all flagged is_mockup=true", async () => {
    const res = await handleListEscalationContacts(
      ctxWith(makeDb(), { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        any_mockup: boolean;
        contacts: Array<{
          role_key: string;
          is_mockup: boolean;
          email: string;
          phone: string;
        }>;
      };
    }>(res);
    expect(body.data.contacts.map((c) => c.role_key).sort()).toEqual(
      [...ESCALATION_CONTACT_ROLE_KEYS].sort(),
    );
    expect(body.data.any_mockup).toBe(true);
    expect(body.data.contacts.every((c) => c.is_mockup)).toBe(true);
  });

  it("allows university_admin (read-only is admin-tier)", async () => {
    const res = await handleListEscalationContacts(
      ctxWith(makeDb(), {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH — RBAC
// ---------------------------------------------------------------------------

describe("PATCH /api/escalation-contacts/:role_key — RBAC", () => {
  const validBody = {
    role_label: "SaaS operator on-call lead",
    person_name: "Real Person",
    email: "oncall@real-customer.edu",
    phone: "+1-415-555-7777",
    notes: "Reachable 24/7.",
  };

  it("requires authentication", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(db, null, {
        method: "PATCH",
        path: "/api/escalation-contacts/operator_oncall",
        body: validBody,
      }),
      "operator_oncall",
    );
    expect(res.status).toBe(401);
    expect(db.updates("escalation_contacts").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("rejects students (403)", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: STUDENT_ID, role: "student", university_id: UNI_A },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/operator_oncall",
          body: validBody,
        },
      ),
      "operator_oncall",
    );
    expect(res.status).toBe(403);
    expect(db.updates("escalation_contacts").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("rejects university_admin (super_admin-only edits per UNI-40 spec)", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: UNI_ADMIN_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/operator_oncall",
          body: validBody,
        },
      ),
      "operator_oncall",
    );
    expect(res.status).toBe(403);
    expect(db.updates("escalation_contacts").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("returns 404 for unknown role_key", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin" },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/not_a_role",
          body: validBody,
        },
      ),
      "not_a_role",
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed payloads (400) without writing", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin" },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/operator_oncall",
          body: {
            ...validBody,
            email: "not-an-email",
          },
        },
      ),
      "operator_oncall",
    );
    expect(res.status).toBe(400);
    expect(db.updates("escalation_contacts").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH — successful round-trip + audit + mockup-vs-real signal
// ---------------------------------------------------------------------------

describe("PATCH /api/escalation-contacts/:role_key — audit + mockup signal", () => {
  it("UPDATEs the row and writes an audit entry transitioning mockup → real", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/operator_oncall",
          body: {
            role_label: "SaaS operator on-call lead",
            person_name: "Real Person",
            email: "oncall@real-customer.edu",
            phone: "+1-415-555-7777",
            notes: "Reachable 24/7.",
          },
        },
      ),
      "operator_oncall",
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        role_key: string;
        is_mockup: boolean;
        person_name: string;
        email: string;
      };
    }>(res);
    expect(body.data.role_key).toBe("operator_oncall");
    expect(body.data.is_mockup).toBe(false);
    expect(body.data.person_name).toBe("Real Person");

    const updates = db.updates("escalation_contacts");
    expect(updates.length).toBe(1);

    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("escalation.contact_updated");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"role_key":"operator_oncall"');
    expect(metadata).toContain('"was_mockup":true');
    expect(metadata).toContain('"is_mockup":false');
    expect(metadata).toContain('"transitioned_to_real":true');
  });

  it("flags is_mockup=true when only the email is real but phone stays in 555-01xx range", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin" },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/customer_dpo",
          body: {
            role_label: "Customer DPO",
            person_name: "Real DPO",
            email: "dpo@real-customer.edu",
            phone: "+1-555-0188",
            notes: "",
          },
        },
      ),
      "customer_dpo",
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { is_mockup: boolean } }>(res);
    expect(body.data.is_mockup).toBe(true);

    const audits = db.inserts("audit_logs");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"transitioned_to_real":false');
  });

  it("flags is_mockup=true when only the phone is real but email is *@example.edu", async () => {
    const db = makeDb();
    const res = await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin" },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/customer_ceo",
          body: {
            role_label: "Customer CEO",
            person_name: "Real CEO",
            email: "ceo@stanton.example.edu",
            phone: "+1-415-555-7777",
            notes: "",
          },
        },
      ),
      "customer_ceo",
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { is_mockup: boolean } }>(res);
    expect(body.data.is_mockup).toBe(true);
  });

  it("after a successful real-data PATCH, GET reports any_mockup=false-for-that-row even though others remain mockup", async () => {
    const db = makeDb();
    await handleUpdateEscalationContact(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin" },
        {
          method: "PATCH",
          path: "/api/escalation-contacts/operator_oncall",
          body: {
            role_label: "SaaS operator on-call lead",
            person_name: "Real Person",
            email: "oncall@real-customer.edu",
            phone: "+1-415-555-7777",
            notes: "",
          },
        },
      ),
      "operator_oncall",
    );

    const res = await handleListEscalationContacts(
      ctxWith(db, { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    const body = await jsonBody<{
      data: {
        any_mockup: boolean;
        contacts: Array<{ role_key: string; is_mockup: boolean }>;
      };
    }>(res);
    expect(body.data.any_mockup).toBe(true); // other 5 rows still mockup
    const oncall = body.data.contacts.find(
      (c) => c.role_key === "operator_oncall",
    );
    expect(oncall?.is_mockup).toBe(false);
    const others = body.data.contacts.filter(
      (c) => c.role_key !== "operator_oncall",
    );
    expect(others.every((c) => c.is_mockup)).toBe(true);
  });
});
