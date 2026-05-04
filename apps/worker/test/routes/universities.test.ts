// Route tests for university CRUD (UNI-11). Focus areas:
//   - Only super_admin can create universities (others 403).
//   - List scoping: super_admin sees all; university_admin sees just theirs;
//     other roles get an empty list (or are scoped down to nothing).
//   - PATCH is restricted to super_admin or that university's admin.
//   - Audit rows are written for every successful create/update.

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleCreateUniversity,
  handleGetUniversity,
  handleListUniversities,
  handleUpdateUniversity,
} from "../../src/routes/universities.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_B_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const ACTORS = {
  superAdmin: {
    id: SUPER_ADMIN_ID,
    email: "super@example.com",
    name: "Super",
    role: "super_admin" as const,
    status: "active" as const,
    university_id: null,
  },
  uniAAdmin: {
    id: UNI_A_ADMIN_ID,
    email: "admin-a@example.com",
    name: "Admin A",
    role: "university_admin" as const,
    status: "active" as const,
    university_id: UNI_A,
  },
  uniBAdmin: {
    id: UNI_B_ADMIN_ID,
    email: "admin-b@example.com",
    name: "Admin B",
    role: "university_admin" as const,
    status: "active" as const,
    university_id: UNI_B,
  },
  staff: {
    id: "00000000-0000-0000-0000-00000000dddd",
    email: "staff@example.com",
    name: "Staff",
    role: "staff" as const,
    status: "active" as const,
    university_id: UNI_A,
  },
};

function uniRow(id: string, name = "Demo U", slug: string | null = "demo-u") {
  return {
    id,
    name,
    slug,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeDb(seed: Array<ReturnType<typeof uniRow>> = [uniRow(UNI_A, "Uni A", "uni-a"), uniRow(UNI_B, "Uni B", "uni-b")]): ProgrammableD1 {
  const db = new ProgrammableD1();
  const byId = new Map(seed.map((u) => [u.id, { ...u }]));
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT id, name, slug, status") && sql.includes("WHERE id = ? LIMIT 1")) {
      return byId.get(String(params[0])) ?? null;
    }
    if (sql.includes("FROM universities WHERE slug = ?")) {
      return null; // no slug collision in tests unless we explicitly seed one
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    if (sql.startsWith("SELECT id, name, slug, status") && sql.includes("ORDER BY name ASC")) {
      return Array.from(byId.values());
    }
    if (sql.startsWith("SELECT id, name, slug, status") && sql.includes("WHERE id = ? LIMIT 1")) {
      const u = byId.get(String(params[0]));
      return u ? [u] : [];
    }
    return undefined;
  });
  // Reflect INSERTs / UPDATEs back into the seed so refetches succeed.
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("insert into universities")) {
      // INSERT order: id, name, slug, status, created_at, updated_at
      byId.set(String(params[0]), {
        id: String(params[0]),
        name: String(params[1]),
        slug: params[2] === null ? null : String(params[2]),
        status: String(params[3]),
        created_at: String(params[4]),
        updated_at: String(params[5]),
      });
    }
  });
  return db;
}

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "x@x",
    MAILGUN_FROM_NAME: "x",
  };
}

function ctx(actor: typeof ACTORS.superAdmin | typeof ACTORS.uniAAdmin | typeof ACTORS.uniBAdmin | typeof ACTORS.staff, db: ProgrammableD1, init?: { method?: string; body?: unknown }): RequestContext {
  const url = new URL(`https://hub.example.com/api/universities`);
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
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
  return { request: new Request(url, requestInit), env: makeEnv(db), url, cookies: {}, auth };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/universities — scoping", () => {
  it("super_admin sees every university", async () => {
    const db = makeDb();
    const res = await handleListUniversities(ctx(ACTORS.superAdmin, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data.length).toBe(2);
  });

  it("university_admin sees only their own university", async () => {
    const db = makeDb();
    const res = await handleListUniversities(ctx(ACTORS.uniAAdmin, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(UNI_A);
  });

  it("non-admin scoped to their own university gets just that one", async () => {
    const db = makeDb();
    const res = await handleListUniversities(ctx(ACTORS.staff, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data.map((r) => r.id)).toEqual([UNI_A]);
  });
});

describe("POST /api/universities — only super_admin", () => {
  it("rejects university_admin", async () => {
    const db = makeDb();
    const res = await handleCreateUniversity(
      ctx(ACTORS.uniAAdmin, db, { method: "POST", body: { name: "New U", slug: "new-u" } }),
    );
    expect(res.status).toBe(403);
    expect(db.inserts("universities").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("super_admin can create + writes a university.created audit row", async () => {
    const db = makeDb();
    const res = await handleCreateUniversity(
      ctx(ACTORS.superAdmin, db, { method: "POST", body: { name: "Brand New", slug: "brand-new" } }),
    );
    expect(res.status).toBe(201);
    expect(db.inserts("universities").length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("university.created");
  });
});

describe("PATCH /api/universities/:id — scoping", () => {
  it("rejects a university_admin editing a sibling university (403)", async () => {
    const db = makeDb();
    const res = await handleUpdateUniversity(
      ctx(ACTORS.uniBAdmin, db, { method: "PATCH", body: { name: "Renamed" } }),
      UNI_A,
    );
    expect(res.status).toBe(403);
    expect(db.updates("universities").length).toBe(0);
  });

  it("super_admin can edit any university and writes a university.updated audit row", async () => {
    const db = makeDb();
    const res = await handleUpdateUniversity(
      ctx(ACTORS.superAdmin, db, { method: "PATCH", body: { name: "Renamed" } }),
      UNI_A,
    );
    expect(res.status).toBe(200);
    expect(db.updates("universities").length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("university.updated");
  });

  it("non-admin can't read another university's row (404)", async () => {
    const db = makeDb();
    const res = await handleGetUniversity(ctx(ACTORS.staff, db), UNI_B);
    expect(res.status).toBe(404);
  });

  it("non-admin can read their own university's row", async () => {
    const db = makeDb();
    const res = await handleGetUniversity(ctx(ACTORS.staff, db), UNI_A);
    expect(res.status).toBe(200);
  });
});
