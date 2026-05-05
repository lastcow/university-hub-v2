// Route tests for the user-facing LMS connect flow (UNI-54; reshaped
// in UNI-63 to use per-user Personal Access Tokens).
//
// Coverage map back to the issue acceptance criteria:
//
//   - "PAT is encrypted at rest in lms_connections.access_token_encrypted —
//     direct DB inspection shows ciphertext only." → "POST /canvas —
//     happy path encrypts PAT".
//   - "User pastes a Canvas PAT, sees it validated against
//     /api/v1/users/self, connects successfully." → "POST /canvas —
//     happy path".
//   - "On 401 from Canvas the row is NOT written and a `invalid_token`
//     surface is returned." → "POST /canvas — 401 from Canvas".
//   - "Disconnect clears the row." → "disconnect — happy path"
//     (DELETE-row).
//   - "All endpoints require an authenticated session; user can only
//     disconnect their own connection." → 401/404 RBAC describe blocks.

import { describe, expect, it } from "vitest";

import { decryptForUniversity, encryptForUniversity } from "../../src/crypto/field-encryption.js";
import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleConnectCanvasConnection,
  handleDisconnectLmsConnection,
  handleListLmsConnections,
} from "../../src/routes/lms-connections.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const USER_A_ID = "00000000-0000-0000-0000-00000000aaaa";
const USER_B_ID = "00000000-0000-0000-0000-00000000bbbb";
const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";
const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";
const CONFIG_A_ID = "33333333-3333-3333-3333-333333333333";

const ENV: Env = {
  DB: undefined as unknown as D1Database,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  LMS_TOKEN_ENCRYPTION_KEY:
    "test-master-key-do-not-use-in-prod-aaaaaaaaaaaaaaaaaaaaaaaaaa",
} as Env;

// ---------------------------------------------------------------------------
// Fixtures + DB helper
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  university_id: string;
  provider_id: string;
  base_url: string;
  enabled: number;
  configured_by_user_id: string | null;
  configured_at: string;
  updated_at: string;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  university_id: string;
  provider_id: string;
  base_url: string;
  access_token_encrypted: string;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SeedOpts {
  configs?: ConfigRow[];
  connections?: ConnectionRow[];
}

function makeDb(seed: SeedOpts = {}): {
  db: ProgrammableD1;
  configs: ConfigRow[];
  connections: ConnectionRow[];
} {
  const db = new ProgrammableD1();
  const configs = (seed.configs ?? []).map((r) => ({ ...r }));
  const connections = (seed.connections ?? []).map((r) => ({ ...r }));

  db.onFirst((sql, params) => {
    if (sql.startsWith("PRAGMA")) return null;
    if (sql.includes("FROM lms_provider_configs")) {
      if (sql.includes("WHERE university_id = ? AND provider_id = ?")) {
        const [uni, provider] = params as [string, string];
        return (
          configs.find(
            (r) => r.university_id === uni && r.provider_id === provider,
          ) ?? null
        );
      }
    }
    if (sql.includes("FROM lms_connections")) {
      if (sql.includes("WHERE id = ?")) {
        const [id] = params as [string];
        return connections.find((r) => r.id === id) ?? null;
      }
      if (sql.includes("WHERE user_id = ? AND provider_id = ?")) {
        const [user, provider] = params as [string, string];
        return (
          connections.find(
            (r) => r.user_id === user && r.provider_id === provider,
          ) ?? null
        );
      }
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    if (
      sql.includes("FROM lms_connections") &&
      sql.includes("WHERE user_id = ? ORDER BY")
    ) {
      const [user] = params as [string];
      return connections
        .filter((r) => r.user_id === user)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return undefined;
  });

  db.onWrite((sql, params) => {
    if (sql.startsWith("INSERT INTO lms_connections")) {
      const [
        id,
        user_id,
        university_id,
        provider_id,
        base_url,
        access_token_encrypted,
        status,
        last_synced_at,
        created_at,
        updated_at,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ];
      connections.push({
        id,
        user_id,
        university_id,
        provider_id,
        base_url,
        access_token_encrypted,
        status,
        last_synced_at,
        created_at,
        updated_at,
      });
    } else if (sql.startsWith("UPDATE lms_connections")) {
      // Re-connect SQL: SET university_id = ?, base_url = ?,
      //   access_token_encrypted = ?, status = ?, updated_at = ?
      //   WHERE id = ?
      if (sql.includes("SET university_id = ?")) {
        const [
          university_id,
          base_url,
          access_token_encrypted,
          status,
          updated_at,
          id,
        ] = params as [string, string, string, string, string, string];
        const row = connections.find((r) => r.id === id);
        if (row) {
          row.university_id = university_id;
          row.base_url = base_url;
          row.access_token_encrypted = access_token_encrypted;
          row.status = status;
          row.updated_at = updated_at;
        }
      }
    } else if (sql.startsWith("DELETE FROM lms_connections")) {
      const [id] = params as [string];
      const ix = connections.findIndex((r) => r.id === id);
      if (ix >= 0) connections.splice(ix, 1);
    }
  });

  return { db, configs, connections };
}

function ctxWith(
  db: ProgrammableD1,
  actor:
    | (Partial<UserRow> & Pick<UserRow, "id" | "role">)
    | null,
  init?: { method?: string; body?: unknown; path?: string; query?: string },
): RequestContext {
  const path = init?.path ?? "/api/lms/connections";
  const url = new URL(
    `https://hub.example.com${path}${init?.query ? `?${init.query}` : ""}`,
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

function seedConfigRow(university_id: string): ConfigRow {
  return {
    id: CONFIG_A_ID,
    university_id,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    enabled: 1,
    configured_by_user_id: SUPER_ADMIN_ID,
    configured_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

async function seedActiveConnectionRow(
  user_id: string,
  university_id: string,
): Promise<ConnectionRow> {
  const accessCt = await encryptForUniversity(ENV, "live-access-token", university_id);
  return {
    id: `cccccccc-cccc-cccc-cccc-cccccccc${user_id.slice(-4)}`,
    user_id,
    university_id,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    access_token_encrypted: accessCt,
    status: "active",
    last_synced_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

/** Wraps `globalThis.fetch` for the duration of the supplied callback so
 *  the connect handler's PAT validation probe lands on a deterministic
 *  fake tenant. */
async function withMockedFetch<T>(
  handler: (input: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  }
}

// ---------------------------------------------------------------------------
// GET /api/lms/connections
// ---------------------------------------------------------------------------

describe("GET /api/lms/connections", () => {
  it("requires authentication (401)", async () => {
    const { db } = makeDb();
    const res = await handleListLmsConnections(ctxWith(db, null));
    expect(res.status).toBe(401);
  });

  it("returns the caller's own connections only — no tokens, no ciphertext", async () => {
    const conn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    const otherConn = await seedActiveConnectionRow(USER_B_ID, UNI_A);
    const { db } = makeDb({ connections: [conn, otherConn] });

    const res = await handleListLmsConnections(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { connections: Array<{ id: string; user_id: string }> };
    }>(res);
    expect(body.data.connections).toHaveLength(1);
    expect(body.data.connections[0]!.user_id).toBe(USER_A_ID);

    const serialized = JSON.stringify(body);
    // No token material — neither plaintext nor ciphertext — leaks.
    expect(serialized).not.toContain("live-access-token");
    expect(serialized).not.toContain(conn.access_token_encrypted);
    expect(serialized).not.toMatch(/"access_token"/);
    expect(serialized).not.toMatch(/"access_token_encrypted"/);
  });

  it("returns an empty list when the user has no connections", async () => {
    const { db } = makeDb();
    const res = await handleListLmsConnections(
      ctxWith(db, { id: USER_A_ID, role: "teacher", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { connections: unknown[] } }>(res);
    expect(body.data.connections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/lms/connections/canvas
// ---------------------------------------------------------------------------

describe("POST /api/lms/connections/canvas", () => {
  it("requires authentication (401)", async () => {
    const { db } = makeDb();
    const res = await handleConnectCanvasConnection(
      ctxWith(db, null, {
        method: "POST",
        body: { personal_access_token: "x" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects users without a university (400)", async () => {
    const { db } = makeDb();
    const res = await handleConnectCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "guest", university_id: null }, {
        method: "POST",
        body: { personal_access_token: "x" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty PATs at the schema layer", async () => {
    const cfg = seedConfigRow(UNI_A);
    const { db, connections } = makeDb({ configs: [cfg] });
    const res = await handleConnectCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
        body: { personal_access_token: "" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("invalid_request");
    expect(connections).toHaveLength(0);
  });

  it("returns 400 when Canvas isn't configured for the university", async () => {
    const { db } = makeDb();
    const res = await handleConnectCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
        body: { personal_access_token: "any-token" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("lms_not_configured");
  });

  it("returns 400 when Canvas is configured but disabled", async () => {
    const cfg = { ...seedConfigRow(UNI_A), enabled: 0 };
    const { db } = makeDb({ configs: [cfg] });
    const res = await handleConnectCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
        body: { personal_access_token: "any-token" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_token when Canvas rejects the PAT (401), writes nothing", async () => {
    const cfg = seedConfigRow(UNI_A);
    const { db, connections } = makeDb({ configs: [cfg] });

    const fake = async (input: string, _init: RequestInit) => {
      expect(input).toBe("https://canvas.example.edu/api/v1/users/self");
      return new Response(JSON.stringify({ errors: ["unauthorized"] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await withMockedFetch(fake, () =>
      handleConnectCanvasConnection(
        ctxWith(
          db,
          { id: USER_A_ID, role: "faculty", university_id: UNI_A },
          {
            method: "POST",
            body: { personal_access_token: "bogus-canvas-token" },
          },
        ),
      ),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("invalid_token");
    // Nothing persisted, no audit row.
    expect(connections).toHaveLength(0);
    expect(db.inserts("lms_connections").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("happy path: validates the PAT, encrypts it, inserts an active row, audits", async () => {
    const cfg = seedConfigRow(UNI_A);
    const { db, connections } = makeDb({ configs: [cfg] });

    const fake = async (input: string, init: RequestInit) => {
      expect(input).toBe("https://canvas.example.edu/api/v1/users/self");
      // Authorization header is the PAT verbatim — that's exactly what
      // we expect, the worker is just proxying it for validation.
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toBe("Bearer the-real-canvas-pat");
      return new Response(JSON.stringify({ id: 4242, name: "Bob" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await withMockedFetch(fake, () =>
      handleConnectCanvasConnection(
        ctxWith(
          db,
          { id: USER_A_ID, role: "faculty", university_id: UNI_A },
          {
            method: "POST",
            body: { personal_access_token: "the-real-canvas-pat" },
          },
        ),
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { ok: true; connection: { status: string; base_url: string } };
    }>(res);
    expect(body.data.ok).toBe(true);
    expect(body.data.connection.status).toBe("active");
    expect(body.data.connection.base_url).toBe("https://canvas.example.edu");

    // No PAT material — neither plaintext nor ciphertext — leaks in
    // the response shape.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("the-real-canvas-pat");
    expect(serialized).not.toMatch(/"access_token"/);
    expect(serialized).not.toMatch(/"access_token_encrypted"/);

    // Connection row inserted, encrypted PAT round-trips back.
    expect(connections.length).toBe(1);
    const row = connections[0]!;
    expect(row.user_id).toBe(USER_A_ID);
    expect(row.university_id).toBe(UNI_A);
    expect(row.status).toBe("active");
    expect(row.access_token_encrypted).toBeTruthy();
    expect(row.access_token_encrypted).not.toBe("the-real-canvas-pat");
    // Confirm the persisted ciphertext does NOT contain the PAT
    // substring anywhere on disk (issue body's explicit assertion).
    expect(row.access_token_encrypted).not.toContain("the-real-canvas-pat");

    const decrypted = await decryptForUniversity(
      ENV,
      row.access_token_encrypted,
      UNI_A,
    );
    expect(decrypted).toBe("the-real-canvas-pat");

    // Cross-tenant decrypt fails closed.
    await expect(
      decryptForUniversity(ENV, row.access_token_encrypted, UNI_B),
    ).rejects.toBeDefined();

    // Audit row written; metadata never carries the PAT.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.connected");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"provider_id":"canvas"');
    expect(meta).toContain('"created":true');
    expect(meta).not.toContain("the-real-canvas-pat");
  });

  it("re-uses an existing row (UPDATE) when the user re-pastes a token", async () => {
    const cfg = seedConfigRow(UNI_A);
    const oldConn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    oldConn.access_token_encrypted = await encryptForUniversity(
      ENV,
      "old-pat",
      UNI_A,
    );
    const { db, connections } = makeDb({
      configs: [cfg],
      connections: [oldConn],
    });

    const fake = async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: 4242 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const res = await withMockedFetch(fake, () =>
      handleConnectCanvasConnection(
        ctxWith(
          db,
          { id: USER_A_ID, role: "faculty", university_id: UNI_A },
          {
            method: "POST",
            body: { personal_access_token: "new-rotated-pat" },
          },
        ),
      ),
    );
    expect(res.status).toBe(200);

    // Still one row (UPDATE, not INSERT).
    expect(connections.length).toBe(1);
    expect(db.inserts("lms_connections").length).toBe(0);
    const row = connections[0]!;
    const decrypted = await decryptForUniversity(
      ENV,
      row.access_token_encrypted,
      UNI_A,
    );
    expect(decrypted).toBe("new-rotated-pat");
    expect(row.status).toBe("active");

    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect((audits[0]!.params[6] as string)).toContain('"created":false');
  });
});

// ---------------------------------------------------------------------------
// POST /api/lms/connections/:id/disconnect
// ---------------------------------------------------------------------------

describe("POST /api/lms/connections/:id/disconnect", () => {
  it("requires authentication (401)", async () => {
    const { db } = makeDb();
    const res = await handleDisconnectLmsConnection(
      ctxWith(db, null, { method: "POST" }),
      "anything",
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 (cloak) when disconnecting a connection that belongs to another user", async () => {
    const conn = await seedActiveConnectionRow(USER_B_ID, UNI_A);
    const { db, connections } = makeDb({ connections: [conn] });

    const res = await handleDisconnectLmsConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
      conn.id,
    );
    expect(res.status).toBe(404);
    // Row untouched.
    expect(connections.length).toBe(1);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("deletes the row outright and writes an audit row", async () => {
    const conn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    const beforeCt = conn.access_token_encrypted;
    const { db, connections } = makeDb({ connections: [conn] });

    const res = await handleDisconnectLmsConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
      conn.id,
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { ok: true } }>(res);
    expect(body.data.ok).toBe(true);

    // Row gone.
    expect(connections.length).toBe(0);

    // Audit row.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.disconnected");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"provider_id":"canvas"');
    expect(meta).toContain('"previous_status":"active"');
    expect(meta).not.toContain(beforeCt);
    expect(meta).not.toContain("live-access-token");

    // Response carries no token material.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("live-access-token");
    expect(serialized).not.toContain(beforeCt);
    expect(serialized).not.toMatch(/"access_token"/);
    expect(serialized).not.toMatch(/"access_token_encrypted"/);
  });
});
