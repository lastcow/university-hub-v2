// Route tests for the user-facing LMS connect flow (UNI-54).
//
// Coverage map back to the issue acceptance criteria:
//
//   - "Tokens are encrypted in lms_connections.access_token_encrypted —
//     not readable plaintext." → "GET — never returns tokens" + "callback
//     — encrypts the access token + refresh token before write".
//   - "User clicks Connect Canvas → consent modal → OAuth → returns
//     connected." → "start — happy path" + "callback — happy path".
//   - "Disconnect clears tokens and flips status to revoked." →
//     "disconnect — happy path".
//   - "CSRF state validation: callback with mismatched state returns 400."
//     → "callback — invalid state" describe block.
//   - "Audit log entries created on connect / disconnect." → audit
//     assertions in callback + disconnect blocks.
//   - "All endpoints require an authenticated session; user can only
//     disconnect their own connection." → 401/404 RBAC describe blocks.
//
// Tests stub the Canvas OAuth token-exchange `fetch` only where the
// callback path needs it. The encryption helper is the real one — we
// confirm the persisted ciphertext is non-empty AND that it round-trips
// back to the plaintext under the same university id (and ONLY under
// that id).

import { describe, expect, it } from "vitest";

import { decryptForUniversity, encryptForUniversity } from "../../src/crypto/field-encryption.js";
import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleCanvasOAuthCallback,
  handleDisconnectLmsConnection,
  handleListLmsConnections,
  handleStartCanvasConnection,
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
  client_id: string;
  client_secret_encrypted: string;
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
  auth_method: string;
  base_url: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scope: string | null;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OauthStateRow {
  state: string;
  user_id: string;
  university_id: string;
  provider_id: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

interface SeedOpts {
  configs?: ConfigRow[];
  connections?: ConnectionRow[];
  states?: OauthStateRow[];
}

function makeDb(seed: SeedOpts = {}): {
  db: ProgrammableD1;
  configs: ConfigRow[];
  connections: ConnectionRow[];
  states: OauthStateRow[];
} {
  const db = new ProgrammableD1();
  const configs = (seed.configs ?? []).map((r) => ({ ...r }));
  const connections = (seed.connections ?? []).map((r) => ({ ...r }));
  const states = (seed.states ?? []).map((r) => ({ ...r }));

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
    if (sql.includes("FROM lms_oauth_states") && sql.includes("WHERE state = ?")) {
      const [s] = params as [string];
      return states.find((r) => r.state === s) ?? null;
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
    if (sql.startsWith("INSERT INTO lms_oauth_states")) {
      const [
        state,
        user_id,
        university_id,
        provider_id,
        redirect_uri,
        created_at,
        expires_at,
      ] = params as [string, string, string, string, string, string, string];
      states.push({
        state,
        user_id,
        university_id,
        provider_id,
        redirect_uri,
        created_at,
        expires_at,
      });
    } else if (sql.startsWith("DELETE FROM lms_oauth_states")) {
      const [s] = params as [string];
      const ix = states.findIndex((r) => r.state === s);
      if (ix >= 0) states.splice(ix, 1);
    } else if (sql.startsWith("INSERT INTO lms_connections")) {
      const [
        id,
        user_id,
        university_id,
        provider_id,
        auth_method,
        base_url,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        scope,
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
        string | null,
        string | null,
        string | null,
        string | null,
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
        auth_method,
        base_url,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        scope,
        status,
        last_synced_at,
        created_at,
        updated_at,
      });
    } else if (sql.startsWith("UPDATE lms_connections")) {
      // The disconnect path. Update by id.
      // Disconnect SQL: SET status = ?, access_token_encrypted = ?,
      //   refresh_token_encrypted = ?, token_expires_at = ?, scope = ?,
      //   updated_at = ? WHERE id = ?
      // Callback re-connect SQL: SET university_id = ?, auth_method = ?,
      //   base_url = ?, access_token_encrypted = ?, refresh_token_encrypted = ?,
      //   token_expires_at = ?, scope = ?, status = ?, updated_at = ?
      //   WHERE id = ?
      if (sql.includes("SET status = ?, access_token_encrypted = ?")) {
        const [
          status,
          access_token_encrypted,
          refresh_token_encrypted,
          token_expires_at,
          scope,
          updated_at,
          id,
        ] = params as [string, string, string | null, string | null, string | null, string, string];
        const row = connections.find((r) => r.id === id);
        if (row) {
          row.status = status;
          row.access_token_encrypted = access_token_encrypted;
          row.refresh_token_encrypted = refresh_token_encrypted;
          row.token_expires_at = token_expires_at;
          row.scope = scope;
          row.updated_at = updated_at;
        }
      } else if (sql.includes("SET university_id = ?, auth_method = ?")) {
        const [
          university_id,
          auth_method,
          base_url,
          access_token_encrypted,
          refresh_token_encrypted,
          token_expires_at,
          scope,
          status,
          updated_at,
          id,
        ] = params as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string,
          string,
        ];
        const row = connections.find((r) => r.id === id);
        if (row) {
          row.university_id = university_id;
          row.auth_method = auth_method;
          row.base_url = base_url;
          row.access_token_encrypted = access_token_encrypted;
          row.refresh_token_encrypted = refresh_token_encrypted;
          row.token_expires_at = token_expires_at;
          row.scope = scope;
          row.status = status;
          row.updated_at = updated_at;
        }
      }
    }
  });

  return { db, configs, connections, states };
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

async function seedConfigRow(university_id: string): Promise<ConfigRow> {
  const ct = await encryptForUniversity(ENV, "the-real-client-secret", university_id);
  return {
    id: CONFIG_A_ID,
    university_id,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    client_id: "the-canvas-oauth-client-id",
    client_secret_encrypted: ct,
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
  const refreshCt = await encryptForUniversity(ENV, "live-refresh-token", university_id);
  return {
    id: `cccccccc-cccc-cccc-cccc-cccccccc${user_id.slice(-4)}`,
    user_id,
    university_id,
    provider_id: "canvas",
    auth_method: "oauth",
    base_url: "https://canvas.example.edu",
    access_token_encrypted: accessCt,
    refresh_token_encrypted: refreshCt,
    token_expires_at: "2027-01-01T00:00:00.000Z",
    scope: "url:GET|/api/v1/courses",
    status: "active",
    last_synced_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
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
    expect(serialized).not.toContain("live-refresh-token");
    expect(serialized).not.toContain(conn.access_token_encrypted ?? "");
    expect(serialized).not.toContain(conn.refresh_token_encrypted ?? "");
    expect(serialized).not.toMatch(/"access_token"/);
    expect(serialized).not.toMatch(/"access_token_encrypted"/);
    expect(serialized).not.toMatch(/"refresh_token"/);
    expect(serialized).not.toMatch(/"refresh_token_encrypted"/);
  });

  it("returns an empty list when the user has no connections", async () => {
    const { db } = makeDb();
    const res = await handleListLmsConnections(
      ctxWith(db, { id: USER_A_ID, role: "teacher", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { connections: unknown[] };
    }>(res);
    expect(body.data.connections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/lms/connections/canvas/start
// ---------------------------------------------------------------------------

describe("POST /api/lms/connections/canvas/start", () => {
  it("requires authentication (401)", async () => {
    const { db } = makeDb();
    const res = await handleStartCanvasConnection(
      ctxWith(db, null, { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects users without a university (400)", async () => {
    const { db } = makeDb();
    const res = await handleStartCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "guest", university_id: null }, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when Canvas isn't configured for the university", async () => {
    const { db } = makeDb();
    const res = await handleStartCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("lms_not_configured");
  });

  it("returns 400 when Canvas is configured but disabled", async () => {
    const cfg = await seedConfigRow(UNI_A);
    cfg.enabled = 0;
    const { db } = makeDb({ configs: [cfg] });
    const res = await handleStartCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("happy path: writes a state row with the calling user_id and returns the authorize URL", async () => {
    const cfg = await seedConfigRow(UNI_A);
    const { db, states } = makeDb({ configs: [cfg] });

    const res = await handleStartCanvasConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
        body: { purpose: "for testing" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        authorize_url: string;
        state: string;
        provider_id: string;
      };
    }>(res);
    expect(body.data.provider_id).toBe("canvas");
    expect(body.data.state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.data.authorize_url).toContain("/login/oauth2/auth");
    expect(body.data.authorize_url).toContain(`state=${body.data.state}`);
    expect(body.data.authorize_url).toContain("response_type=code");
    expect(body.data.authorize_url).toContain(
      `client_id=${encodeURIComponent(cfg.client_id)}`,
    );
    expect(body.data.authorize_url).toContain("purpose=for+testing");
    // The redirect URI we send to Canvas points back at our callback path.
    expect(body.data.authorize_url).toMatch(
      /redirect_uri=https%3A%2F%2Fhub\.example\.com%2Fapi%2Flms%2Fconnections%2Fcanvas%2Fcallback/,
    );

    // State row is bound to the calling user.
    expect(states.length).toBe(1);
    expect(states[0]!.user_id).toBe(USER_A_ID);
    expect(states[0]!.university_id).toBe(UNI_A);
    expect(states[0]!.provider_id).toBe("canvas");
    expect(states[0]!.state).toBe(body.data.state);
    // 10-minute TTL by spec — verify the row's expires_at is in the future.
    expect(Date.parse(states[0]!.expires_at)).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// GET /api/lms/connections/canvas/callback
// ---------------------------------------------------------------------------

describe("GET /api/lms/connections/canvas/callback — invalid state", () => {
  it("returns 400 when state is missing entirely", async () => {
    const { db } = makeDb();
    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "code=xyz",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when code is missing", async () => {
    const { db } = makeDb();
    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "state=abc",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when state does not match any row (replay / forged)", async () => {
    const { db } = makeDb();
    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "code=xyz&state=does-not-exist",
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("invalid_state");
  });

  it("returns 400 when the state belongs to a different user (CSRF)", async () => {
    const cfg = await seedConfigRow(UNI_A);
    const { db, states, connections } = makeDb({
      configs: [cfg],
      states: [
        {
          state: "valid-but-belongs-to-someone-else",
          user_id: USER_B_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          redirect_uri:
            "https://hub.example.com/api/lms/connections/canvas/callback",
          created_at: "2026-05-05T00:00:00.000Z",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "code=xyz&state=valid-but-belongs-to-someone-else",
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("invalid_state");
    // No connection row written; no audit row written.
    expect(connections.length).toBe(0);
    expect(db.inserts("lms_connections").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
    // State row is consumed even on the failure path so a real attacker
    // can't replay the same value once it's been touched.
    expect(states.length).toBe(0);
  });

  it("returns 400 when the state row has expired", async () => {
    const cfg = await seedConfigRow(UNI_A);
    const { db } = makeDb({
      configs: [cfg],
      states: [
        {
          state: "expired-state",
          user_id: USER_A_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          redirect_uri:
            "https://hub.example.com/api/lms/connections/canvas/callback",
          created_at: "2026-04-01T00:00:00.000Z",
          expires_at: "2026-04-01T00:10:00.000Z",
        },
      ],
    });

    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "code=xyz&state=expired-state",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("redirects to the SPA error page when Canvas itself returned `error=...`", async () => {
    const { db } = makeDb();
    const res = await handleCanvasOAuthCallback(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "GET",
        path: "/api/lms/connections/canvas/callback",
        query: "error=access_denied",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://hub.example.com/app/integrations?lms_error=canvas&detail=access_denied",
    );
  });
});

describe("GET /api/lms/connections/canvas/callback — happy path (state valid)", () => {
  // We patch globalThis.fetch for the duration of the callback test so the
  // real `exchangeCodeForTokens` helper completes against a fake Canvas
  // token endpoint. The fake returns a success body; the route handler is
  // expected to encrypt+persist the access + refresh tokens.
  async function runCallback(opts: {
    user: typeof USER_A_ID;
    role: UserRow["role"];
    canvasResponse?: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    canvasStatus?: number;
    db: ProgrammableD1;
    state: string;
    code: string;
  }): Promise<Response> {
    const fetchSpy = async (
      input: string,
      init: RequestInit,
    ): Promise<Response> => {
      // Sanity: exchange POSTs against the token endpoint.
      expect(input).toBe("https://canvas.example.edu/login/oauth2/token");
      expect(init.method).toBe("POST");
      const body = (init.body as string) ?? "";
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain(`code=${opts.code}`);
      expect(body).toContain(
        "redirect_uri=https%3A%2F%2Fhub.example.com%2Fapi%2Flms%2Fconnections%2Fcanvas%2Fcallback",
      );
      // The plaintext OAuth client_secret should be on the body — that's
      // the whole point of decrypting it just-in-time. We do NOT echo it
      // anywhere else.
      expect(body).toContain("client_secret=the-real-client-secret");
      return new Response(
        JSON.stringify(
          opts.canvasResponse ?? {
            access_token: "fresh-access-token-from-canvas",
            refresh_token: "fresh-refresh-token-from-canvas",
            expires_in: 3600,
            scope: "url:GET|/api/v1/courses",
          },
        ),
        {
          status: opts.canvasStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as typeof fetch;
    try {
      return await handleCanvasOAuthCallback(
        ctxWith(opts.db, { id: opts.user, role: opts.role, university_id: UNI_A }, {
          method: "GET",
          path: "/api/lms/connections/canvas/callback",
          query: `code=${opts.code}&state=${opts.state}`,
        }),
      );
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  it("exchanges the code, encrypts both tokens, inserts an active row, audits, redirects", async () => {
    const cfg = await seedConfigRow(UNI_A);
    const stateValue = "happy-state-value";
    const { db, connections } = makeDb({
      configs: [cfg],
      states: [
        {
          state: stateValue,
          user_id: USER_A_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          redirect_uri:
            "https://hub.example.com/api/lms/connections/canvas/callback",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    const res = await runCallback({
      user: USER_A_ID,
      role: "faculty",
      db,
      state: stateValue,
      code: "the-canvas-auth-code",
    });

    // Redirect lands on the SPA integrations page with ?connected=canvas.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://hub.example.com/app/integrations?connected=canvas",
    );

    // Connection row inserted, status active, both tokens encrypted on disk.
    expect(connections.length).toBe(1);
    const row = connections[0]!;
    expect(row.user_id).toBe(USER_A_ID);
    expect(row.university_id).toBe(UNI_A);
    expect(row.status).toBe("active");
    expect(row.auth_method).toBe("oauth");
    expect(row.access_token_encrypted).toBeTruthy();
    expect(row.access_token_encrypted).not.toBe("fresh-access-token-from-canvas");
    expect(row.refresh_token_encrypted).toBeTruthy();
    expect(row.refresh_token_encrypted).not.toBe("fresh-refresh-token-from-canvas");

    // Round-trip the ciphertext under the same university id — that's
    // the at-rest contract the issue calls for.
    const decryptedAccess = await decryptForUniversity(
      ENV,
      row.access_token_encrypted!,
      UNI_A,
    );
    expect(decryptedAccess).toBe("fresh-access-token-from-canvas");
    const decryptedRefresh = await decryptForUniversity(
      ENV,
      row.refresh_token_encrypted!,
      UNI_A,
    );
    expect(decryptedRefresh).toBe("fresh-refresh-token-from-canvas");

    // Cross-tenant decrypt fails closed — the GCM tag check rejects the
    // wrong (master, university_id) pair. Belt-and-braces verification of
    // the per-tenant blast-radius bound from sub-issue UNI-51.
    await expect(
      decryptForUniversity(ENV, row.access_token_encrypted!, UNI_B),
    ).rejects.toBeDefined();

    // Audit row written with action `lms.connected`, no token material.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.connected");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"provider_id":"canvas"');
    expect(meta).toContain('"created":true');
    expect(meta).toContain('"has_refresh_token":true');
    expect(meta).not.toContain("fresh-access-token-from-canvas");
    expect(meta).not.toContain("fresh-refresh-token-from-canvas");
  });

  it("re-uses an existing row (UPDATE) when the user reconnects", async () => {
    const cfg = await seedConfigRow(UNI_A);
    const oldConn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    oldConn.access_token_encrypted = await encryptForUniversity(
      ENV,
      "stale-access-token",
      UNI_A,
    );
    const stateValue = "reconnect-state";
    const { db, connections } = makeDb({
      configs: [cfg],
      connections: [oldConn],
      states: [
        {
          state: stateValue,
          user_id: USER_A_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          redirect_uri:
            "https://hub.example.com/api/lms/connections/canvas/callback",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    const res = await runCallback({
      user: USER_A_ID,
      role: "faculty",
      db,
      state: stateValue,
      code: "the-canvas-auth-code",
    });
    expect(res.status).toBe(302);

    // Still one row (UPDATE, not INSERT-on-duplicate-user).
    expect(connections.length).toBe(1);
    expect(db.inserts("lms_connections").length).toBe(0);
    const row = connections[0]!;
    const decrypted = await decryptForUniversity(
      ENV,
      row.access_token_encrypted!,
      UNI_A,
    );
    expect(decrypted).toBe("fresh-access-token-from-canvas");
    expect(row.status).toBe("active");

    // Audit row marks `created: false` so post-incident review can tell
    // a re-connect from a first-connect.
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
    expect(connections[0]!.status).toBe("active");
    expect(db.updates("lms_connections").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("clears tokens, flips status to revoked, audits", async () => {
    const conn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    const beforeAccessCt = conn.access_token_encrypted;
    const beforeRefreshCt = conn.refresh_token_encrypted;
    const { db, connections } = makeDb({ connections: [conn] });

    const res = await handleDisconnectLmsConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
      conn.id,
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        ok: true;
        connection: { status: string; auth_method: string };
      };
    }>(res);
    expect(body.data.ok).toBe(true);
    expect(body.data.connection.status).toBe("revoked");

    // Row is updated: status=revoked, both encrypted columns nulled / cleared.
    const row = connections[0]!;
    expect(row.status).toBe("revoked");
    expect(row.access_token_encrypted).toBe("");
    expect(row.refresh_token_encrypted).toBeNull();
    expect(row.token_expires_at).toBeNull();
    expect(row.scope).toBeNull();
    // The previous ciphertext is gone (defense in depth — even though
    // we already cleared the column, double-check we didn't leave the
    // bytes anywhere).
    expect(row.access_token_encrypted).not.toBe(beforeAccessCt);
    expect(row.refresh_token_encrypted).not.toBe(beforeRefreshCt);

    // Audit row.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.disconnected");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"provider_id":"canvas"');
    expect(meta).toContain('"previous_status":"active"');
    expect(meta).toContain('"auth_method":"oauth"');

    // No part of the response carries the prior ciphertext or any token.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("live-access-token");
    expect(serialized).not.toContain("live-refresh-token");
    expect(serialized).not.toContain(beforeAccessCt ?? "");
    expect(serialized).not.toContain(beforeRefreshCt ?? "");
    expect(serialized).not.toMatch(/"access_token"/);
    expect(serialized).not.toMatch(/"access_token_encrypted"/);
    expect(serialized).not.toMatch(/"refresh_token"/);
    expect(serialized).not.toMatch(/"refresh_token_encrypted"/);
  });

  it("disconnecting an already-revoked connection still writes an audit row but no UPDATE", async () => {
    const conn = await seedActiveConnectionRow(USER_A_ID, UNI_A);
    conn.status = "revoked";
    conn.access_token_encrypted = "";
    conn.refresh_token_encrypted = null;
    const { db } = makeDb({ connections: [conn] });
    const res = await handleDisconnectLmsConnection(
      ctxWith(db, { id: USER_A_ID, role: "faculty", university_id: UNI_A }, {
        method: "POST",
      }),
      conn.id,
    );
    expect(res.status).toBe(200);
    expect(db.updates("lms_connections").length).toBe(0);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect((audits[0]!.params[6] as string)).toContain('"already_revoked":true');
  });
});
