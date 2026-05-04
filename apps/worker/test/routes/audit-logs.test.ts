// Route tests for /api/audit-logs (UNI-14). The acceptance criteria call out
// university-scoping for university_admin vs super_admin and forbidding lower
// roles, plus filter + pagination wiring.

import { describe, expect, it } from "vitest";

import type { AuditAction, Role } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleListAuditLogs } from "../../src/routes/audit-logs.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_B_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";
const STAFF_ID = "00000000-0000-0000-0000-00000000dddd";
const TEACHER_ID = "00000000-0000-0000-0000-00000000eeee";

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
  uniBAdmin: {
    id: UNI_B_ADMIN_ID,
    email: "admin-b@example.com",
    name: "Admin B",
    role: "university_admin",
    status: "active",
    university_id: UNI_B,
  },
  staff: {
    id: STAFF_ID,
    email: "staff@example.com",
    name: "Staff",
    role: "staff",
    status: "active",
    university_id: UNI_A,
  },
  teacher: {
    id: TEACHER_ID,
    email: "teacher@example.com",
    name: "Teacher",
    role: "teacher",
    status: "active",
    university_id: UNI_A,
  },
};

interface AuditFixture {
  id: string;
  university_id: string | null;
  actor_user_id: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: string | null;
  metadata_json: string | null;
  created_at: string;
  university_name: string | null;
  actor_name: string | null;
  actor_email: string | null;
}

function audit(
  id: string,
  university_id: string | null,
  action: AuditAction,
  extras: Partial<AuditFixture> = {},
): AuditFixture {
  return {
    id,
    university_id,
    actor_user_id: null,
    action,
    entity_type: null,
    entity_id: null,
    metadata_json: null,
    created_at: "2026-01-01T00:00:00.000Z",
    university_name: null,
    actor_name: null,
    actor_email: null,
    ...extras,
  };
}

const SEED: AuditFixture[] = [
  audit("a1", UNI_A, "invitation.created", {
    metadata_json: JSON.stringify({ role: "staff" }),
    university_name: "Uni A",
  }),
  audit("a2", UNI_A, "user.role_changed", {
    metadata_json: JSON.stringify({ from: "staff", to: "teacher" }),
    university_name: "Uni A",
  }),
  audit("a3", UNI_B, "invitation.accepted", { university_name: "Uni B" }),
  audit("b1", null, "settings.updated", {
    metadata_json: JSON.stringify({ key: "appearance" }),
  }),
];

function applyWhere(rows: AuditFixture[], sql: string, params: readonly unknown[]) {
  let pi = 0;
  let out = rows;
  // Order matters and matches the route's where-clause ordering.
  if (sql.includes("a.university_id = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.university_id === target);
  }
  if (sql.includes("a.action = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.action === target);
  }
  if (sql.includes("a.entity_type = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.entity_type === target);
  }
  if (sql.includes("a.actor_user_id = ?")) {
    const target = params[pi++];
    out = out.filter((r) => r.actor_user_id === target);
  }
  if (sql.includes("a.created_at >= ?")) {
    const target = String(params[pi++]);
    out = out.filter((r) => r.created_at >= target);
  }
  if (sql.includes("a.created_at <= ?")) {
    const target = String(params[pi++]);
    out = out.filter((r) => r.created_at <= target);
  }
  return { rows: out, paramsConsumed: pi };
}

function makeDb(seed: AuditFixture[] = SEED): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT COUNT(1) AS c FROM audit_logs")) {
      const { rows } = applyWhere(seed, sql, params);
      return { c: rows.length } as { c: number };
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    if (sql.startsWith("SELECT a.id, a.university_id")) {
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
  const url = new URL(`https://hub.example.com/api/audit-logs${query ? `?${query}` : ""}`);
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
    items: Array<{ id: string; university_id: string | null; action: AuditAction; metadata: unknown }>;
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

async function readBody(res: Response): Promise<ListBody> {
  return (await res.json()) as ListBody;
}

describe("GET /api/audit-logs — RBAC", () => {
  it("403s for staff", async () => {
    const res = await handleListAuditLogs(ctx(ACTORS.staff, makeDb()));
    expect(res.status).toBe(403);
  });

  it("403s for teacher / student / TA / guest / viewer", async () => {
    for (const role of ["teacher", "student", "teacher_assistant", "guest", "viewer"] as Role[]) {
      const actor = { ...ACTORS.teacher, role };
      const res = await handleListAuditLogs(ctx(actor, makeDb()));
      expect(res.status, `role=${role}`).toBe(403);
    }
  });

  it("401s when unauthenticated", async () => {
    const db = makeDb();
    const url = new URL("https://hub.example.com/api/audit-logs");
    const res = await handleListAuditLogs({
      request: new Request(url),
      env: makeEnv(db),
      url,
      cookies: {},
      auth: null,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/audit-logs — university scoping", () => {
  it("super_admin sees rows from every university (no scoping clause)", async () => {
    const res = await handleListAuditLogs(ctx(ACTORS.superAdmin, makeDb()));
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.data.items).toHaveLength(SEED.length);
    expect(body.data.total).toBe(SEED.length);
  });

  it("super_admin can narrow with ?university_id", async () => {
    const res = await handleListAuditLogs(
      ctx(ACTORS.superAdmin, makeDb(), `university_id=${UNI_A}`),
    );
    const body = await readBody(res);
    const universityIds = new Set(body.data.items.map((r) => r.university_id));
    expect(universityIds).toEqual(new Set([UNI_A]));
    expect(body.data.total).toBe(2);
  });

  it("university_admin sees only their own university's rows", async () => {
    const res = await handleListAuditLogs(ctx(ACTORS.uniAAdmin, makeDb()));
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.university_id === UNI_A)).toBe(true);
    expect(body.data.total).toBe(2);
  });

  it("university_admin cannot widen scope by passing another university_id", async () => {
    // The handler ignores ?university_id for non-super_admins and locks the
    // filter to actor.university_id, so passing UNI_B as a university_admin
    // for UNI_A still returns UNI_A rows.
    const res = await handleListAuditLogs(
      ctx(ACTORS.uniAAdmin, makeDb(), `university_id=${UNI_B}`),
    );
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.university_id === UNI_A)).toBe(true);
    expect(body.data.items.find((r) => r.university_id === UNI_B)).toBeUndefined();
  });
});

describe("GET /api/audit-logs — filters and metadata parsing", () => {
  it("filters by action", async () => {
    const res = await handleListAuditLogs(
      ctx(ACTORS.superAdmin, makeDb(), "action=invitation.created"),
    );
    const body = await readBody(res);
    expect(body.data.items.every((r) => r.action === "invitation.created")).toBe(true);
    expect(body.data.total).toBe(1);
  });

  it("rejects unknown action with 400", async () => {
    const res = await handleListAuditLogs(
      ctx(ACTORS.superAdmin, makeDb(), "action=does.not.exist"),
    );
    expect(res.status).toBe(400);
  });

  it("parses metadata_json into a structured object on the response", async () => {
    const res = await handleListAuditLogs(ctx(ACTORS.superAdmin, makeDb()));
    const body = await readBody(res);
    const row = body.data.items.find((r) => r.action === "user.role_changed");
    expect(row?.metadata).toEqual({ from: "staff", to: "teacher" });
  });
});

describe("GET /api/audit-logs — pagination", () => {
  it("respects limit + offset and returns has_more", async () => {
    const res = await handleListAuditLogs(
      ctx(ACTORS.superAdmin, makeDb(), "limit=2&offset=0"),
    );
    const body = await readBody(res);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.total).toBe(SEED.length);
    expect(body.data.has_more).toBe(true);

    const res2 = await handleListAuditLogs(
      ctx(ACTORS.superAdmin, makeDb(), "limit=2&offset=2"),
    );
    const body2 = await readBody(res2);
    expect(body2.data.items).toHaveLength(2);
    expect(body2.data.has_more).toBe(false);
  });
});
