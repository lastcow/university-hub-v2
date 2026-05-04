// Route tests for /api/email-logs (UNI-14). Issue acceptance criteria call
// out 403 from student/teacher/TA/guest, plus filter + scoping wiring.

import { describe, expect, it } from "vitest";

import type { EmailLogStatus, EmailType, Role } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleListEmailLogs } from "../../src/routes/email-logs.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const STAFF_ID = "00000000-0000-0000-0000-00000000cccc";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

interface ActorFixture {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active";
  university_id: string | null;
}

const ACTORS: Record<string, ActorFixture> = {
  superAdmin: {
    id: SUPER_ADMIN_ID,
    email: "super@example.com",
    name: "Super",
    role: "super_admin",
    status: "active",
    university_id: null,
  },
  uniAAdmin: {
    id: UNI_A_ADMIN_ID,
    email: "admin-a@example.com",
    name: "Admin A",
    role: "university_admin",
    status: "active",
    university_id: UNI_A,
  },
  staff: {
    id: STAFF_ID,
    email: "staff@example.com",
    name: "Staff",
    role: "staff",
    status: "active",
    university_id: UNI_A,
  },
};

interface EmailFixture {
  id: string;
  university_id: string | null;
  recipient_email: string;
  type: EmailType;
  template_name: string | null;
  status: EmailLogStatus;
  mailgun_message_id: string | null;
  error: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
  university_name: string | null;
}

function email(
  id: string,
  university_id: string | null,
  type: EmailType,
  status: EmailLogStatus,
  recipient: string,
  extras: Partial<EmailFixture> = {},
): EmailFixture {
  return {
    id,
    university_id,
    recipient_email: recipient,
    type,
    template_name: null,
    status,
    mailgun_message_id: null,
    error: null,
    related_entity_type: null,
    related_entity_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    university_name: null,
    ...extras,
  };
}

const SEED: EmailFixture[] = [
  email("e1", UNI_A, "invitation", "sent", "alice@example.com", {
    mailgun_message_id: "mg-1",
    template_name: "university_hub_invitation",
    related_entity_type: "invitation",
    related_entity_id: "inv-1",
  }),
  email("e2", UNI_A, "welcome", "failed", "bob@example.com", {
    error: "Mailgun not configured",
  }),
  email("e3", UNI_B, "invitation_resend", "sent", "carol@example.com"),
  email("e4", null, "contact_notification", "pending", "team@hub.example"),
];

function applyWhere(rows: EmailFixture[], sql: string, params: readonly unknown[]) {
  let pi = 0;
  let out = rows;
  if (sql.includes("e.university_id = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.university_id === target);
  }
  if (sql.includes("e.type = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.type === target);
  }
  if (sql.includes("LOWER(e.recipient_email) LIKE ?")) {
    const target = String(params[pi++]).replaceAll("%", "");
    out = out.filter((r) => r.recipient_email.toLowerCase().includes(target));
  }
  if (sql.includes("e.status = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.status === target);
  }
  if (sql.includes("e.created_at >= ?")) {
    const target = String(params[pi++]);
    out = out.filter((r) => r.created_at >= target);
  }
  if (sql.includes("e.created_at <= ?")) {
    const target = String(params[pi++]);
    out = out.filter((r) => r.created_at <= target);
  }
  return { rows: out, paramsConsumed: pi };
}

function makeDb(seed: EmailFixture[] = SEED): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT COUNT(1) AS c FROM email_logs")) {
      const { rows } = applyWhere(seed, sql, params);
      return { c: rows.length } as { c: number };
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    if (sql.startsWith("SELECT e.id, e.university_id")) {
      const { rows, paramsConsumed } = applyWhere(seed, sql, params);
      const limit = Number(params[paramsConsumed]);
      const offset = Number(params[paramsConsumed + 1]);
      const sorted = [...rows].sort((a, b) =>
        a.created_at < b.created_at
          ? 1
          : a.created_at > b.created_at
            ? -1
            : a.id < b.id
              ? 1
              : -1,
      );
      return sorted.slice(offset, offset + limit);
    }
    return undefined;
  });
  return db;
}

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
  } as Env;
}

function ctx(actor: ActorFixture, db: ProgrammableD1, query = ""): RequestContext {
  const url = new URL(
    `https://hub.example.com/api/email-logs${query ? `?${query}` : ""}`,
  );
  const auth: AuthState = {
    user: { ...actor, password_hash: "x" } as unknown as UserRow,
    session: {
      id: "s",
      user_id: actor.id,
      token_hash: "h",
      expires_at: "2099",
      created_at: "2026",
    },
  };
  return {
    request: new Request(url, { method: "GET" }),
    env: makeEnv(db),
    url,
    cookies: {},
    auth,
  };
}

interface ListBody {
  data: {
    items: Array<{
      id: string;
      university_id: string | null;
      type: EmailType;
      status: EmailLogStatus;
      recipient_email: string;
    }>;
    total: number;
    has_more: boolean;
  };
}

async function readBody(res: Response): Promise<ListBody> {
  return (await res.json()) as ListBody;
}

describe("GET /api/email-logs — RBAC", () => {
  it("403s for student / teacher / TA / guest / viewer / staff", async () => {
    const denied: Role[] = [
      "student",
      "teacher",
      "teacher_assistant",
      "guest",
      "viewer",
      "staff",
      "faculty",
    ];
    for (const role of denied) {
      const actor: ActorFixture = { ...ACTORS.staff, role };
      const res = await handleListEmailLogs(ctx(actor, makeDb()));
      expect(res.status, `role=${role}`).toBe(403);
    }
  });

  it("401s when unauthenticated", async () => {
    const db = makeDb();
    const url = new URL("https://hub.example.com/api/email-logs");
    const res = await handleListEmailLogs({
      request: new Request(url),
      env: makeEnv(db),
      url,
      cookies: {},
      auth: null,
    });
    expect(res.status).toBe(401);
  });

  it("allows super_admin", async () => {
    const res = await handleListEmailLogs(ctx(ACTORS.superAdmin, makeDb()));
    expect(res.status).toBe(200);
  });

  it("allows university_admin (scoped to their own university)", async () => {
    const res = await handleListEmailLogs(ctx(ACTORS.uniAAdmin, makeDb()));
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.university_id === UNI_A)).toBe(true);
    expect(body.data.total).toBe(2);
  });
});

describe("GET /api/email-logs — filters", () => {
  it("filters by status=failed", async () => {
    const res = await handleListEmailLogs(
      ctx(ACTORS.superAdmin, makeDb(), "status=failed"),
    );
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.status === "failed")).toBe(true);
    expect(body.data.total).toBe(1);
  });

  it("filters by email_type=invitation", async () => {
    const res = await handleListEmailLogs(
      ctx(ACTORS.superAdmin, makeDb(), "email_type=invitation"),
    );
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.type === "invitation")).toBe(true);
    expect(body.data.total).toBe(1);
  });

  it("filters by recipient (case-insensitive substring)", async () => {
    const res = await handleListEmailLogs(
      ctx(ACTORS.superAdmin, makeDb(), "recipient=ALICE"),
    );
    const body = await readBody(res);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]!.recipient_email).toBe("alice@example.com");
  });

  it("rejects unknown status with 400", async () => {
    const res = await handleListEmailLogs(
      ctx(ACTORS.superAdmin, makeDb(), "status=bogus"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown email_type with 400", async () => {
    const res = await handleListEmailLogs(
      ctx(ACTORS.superAdmin, makeDb(), "email_type=unknown"),
    );
    expect(res.status).toBe(400);
  });
});
