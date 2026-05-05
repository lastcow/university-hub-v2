// Route tests for the LMS provider-config admin surface (UNI-53;
// reshaped in UNI-63 to drop the OAuth client fields and add an
// optional PAT-validation probe).
//
// Coverage map back to UNI-63 acceptance criteria:
//
//   - "Admin sets Canvas base URL on Settings → Integrations; non-https
//     URLs rejected at write time." → "POST — validation".
//   - "Optional validate-on-save: probe `<base_url>/api/v1/users/self`
//     with an admin-supplied test PAT." → "POST — test_pat probe".
//   - "Audit log row created on every config change." → audit
//     assertions in POST + DELETE blocks.
//   - "Non-admin users do NOT see the Integrations admin tab and get 403
//     on its endpoints." → RBAC blocks.

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleDeleteLmsProviderConfig,
  handleListEnabledLmsProviders,
  handleListLmsProviderConfigs,
  handleUpsertLmsProviderConfig,
} from "../../src/routes/lms-provider-configs.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_ADMIN_A_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_ADMIN_B_ID = "00000000-0000-0000-0000-00000000bbbc";
const STUDENT_ID = "00000000-0000-0000-0000-00000000cccc";
const FACULTY_ID = "00000000-0000-0000-0000-00000000dddd";
const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

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

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

function makeDb(seed: ConfigRow[] = []): ProgrammableD1 {
  const db = new ProgrammableD1();
  const rows = seed.map((r) => ({ ...r }));

  db.onFirst((sql, params) => {
    if (sql.startsWith("PRAGMA")) return null;
    if (sql.includes("FROM lms_provider_configs")) {
      if (sql.includes("WHERE id = ?")) {
        const [id] = params as [string];
        return rows.find((r) => r.id === id) ?? null;
      }
      if (sql.includes("WHERE university_id = ? AND provider_id = ?")) {
        const [uni, provider] = params as [string, string];
        return (
          rows.find(
            (r) => r.university_id === uni && r.provider_id === provider,
          ) ?? null
        );
      }
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    if (
      sql.includes("FROM lms_provider_configs") &&
      sql.includes("WHERE university_id = ? ORDER BY")
    ) {
      const [uni] = params as [string];
      return rows
        .filter((r) => r.university_id === uni)
        .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
    }
    return undefined;
  });

  db.onWrite((sql, params) => {
    if (sql.startsWith("INSERT INTO lms_provider_configs")) {
      const [
        id,
        university_id,
        provider_id,
        base_url,
        enabled,
        configured_by_user_id,
        configured_at,
        updated_at,
      ] = params as [
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        string,
      ];
      rows.push({
        id,
        university_id,
        provider_id,
        base_url,
        enabled,
        configured_by_user_id,
        configured_at,
        updated_at,
      });
    } else if (sql.startsWith("UPDATE lms_provider_configs")) {
      const [
        base_url,
        enabled,
        configured_by_user_id,
        updated_at,
        id,
      ] = params as [string, number, string, string, string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.base_url = base_url;
        row.enabled = enabled;
        row.configured_by_user_id = configured_by_user_id;
        row.updated_at = updated_at;
      }
    } else if (sql.startsWith("DELETE FROM lms_provider_configs")) {
      const [id] = params as [string];
      const ix = rows.findIndex((r) => r.id === id);
      if (ix >= 0) rows.splice(ix, 1);
    }
  });

  return db;
}

const ENV: Env = {
  DB: undefined as unknown as D1Database,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  LMS_TOKEN_ENCRYPTION_KEY:
    "test-master-key-do-not-use-in-prod-aaaaaaaaaaaaaaaaaaaaaaaaaa",
} as Env;

function ctxWith(
  db: ProgrammableD1,
  actor:
    | (Partial<UserRow> & Pick<UserRow, "id" | "role">)
    | null,
  init?: { method?: string; body?: unknown; path?: string; query?: string },
): RequestContext {
  const path = init?.path ?? "/api/lms/provider-configs";
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

function seedCanvasRow(university_id: string): ConfigRow {
  return {
    id: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa${university_id.slice(0, 4)}`,
    university_id,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    enabled: 1,
    configured_by_user_id: SUPER_ADMIN_ID,
    configured_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

const VALID_CREATE_BODY = {
  provider_id: "canvas" as const,
  base_url: "https://canvas.example.edu",
  enabled: true,
};

/** Wrap globalThis.fetch for the duration of a test that exercises the
 *  optional `test_pat` probe. */
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
// GET — RBAC + scoping
// ---------------------------------------------------------------------------

describe("GET /api/lms/provider-configs — RBAC", () => {
  it("requires authentication", async () => {
    const res = await handleListLmsProviderConfigs(ctxWith(makeDb(), null));
    expect(res.status).toBe(401);
  });

  it("rejects students (403)", async () => {
    const res = await handleListLmsProviderConfigs(
      ctxWith(makeDb(), {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects faculty (403)", async () => {
    const res = await handleListLmsProviderConfigs(
      ctxWith(makeDb(), {
        id: FACULTY_ID,
        role: "faculty",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows university_admin (their own university)", async () => {
    const db = makeDb([seedCanvasRow(UNI_A)]);
    const res = await handleListLmsProviderConfigs(
      ctxWith(db, {
        id: UNI_ADMIN_A_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows super_admin", async () => {
    const db = makeDb([seedCanvasRow(UNI_A)]);
    const res = await handleListLmsProviderConfigs(
      ctxWith(db, {
        id: SUPER_ADMIN_ID,
        role: "super_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/lms/provider-configs — response shape", () => {
  it("returns the configured row with no OAuth-shaped fields", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleListLmsProviderConfigs(
      ctxWith(db, {
        id: UNI_ADMIN_A_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        providers: Array<{
          provider_id: string;
          display_name: string;
          config: { base_url: string; enabled: boolean } | null;
        }>;
      };
    }>(res);

    // No OAuth-shaped fields anywhere on the wire.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"client_id"/);
    expect(serialized).not.toMatch(/"client_id_last4"/);
    expect(serialized).not.toMatch(/"client_secret"/);
    expect(serialized).not.toMatch(/"client_secret_encrypted"/);
    expect(serialized).not.toMatch(/"has_client_secret"/);

    const canvas = body.data.providers.find(
      (p) => p.provider_id === "canvas",
    );
    expect(canvas).toBeDefined();
    expect(canvas?.config?.base_url).toBe("https://canvas.example.edu");
    expect(canvas?.config?.enabled).toBe(true);
  });

  it("returns the registry summary even when no row is configured (config: null)", async () => {
    const res = await handleListLmsProviderConfigs(
      ctxWith(makeDb(), {
        id: UNI_ADMIN_A_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        providers: Array<{ provider_id: string; config: unknown | null }>;
      };
    }>(res);
    const canvas = body.data.providers.find(
      (p) => p.provider_id === "canvas",
    );
    expect(canvas?.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST — RBAC, validation, persistence + audit
// ---------------------------------------------------------------------------

describe("POST /api/lms/provider-configs — RBAC", () => {
  it("requires authentication", async () => {
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(makeDb(), null, { method: "POST", body: VALID_CREATE_BODY }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects students (403)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: STUDENT_ID, role: "student", university_id: UNI_A },
        { method: "POST", body: VALID_CREATE_BODY },
      ),
    );
    expect(res.status).toBe(403);
    expect(db.inserts("lms_provider_configs").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("rejects university_admin attempting to target another university (403)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "POST",
          body: VALID_CREATE_BODY,
          query: `university_id=${UNI_B}`,
        },
      ),
    );
    expect(res.status).toBe(403);
    expect(db.inserts("lms_provider_configs").length).toBe(0);
  });
});

describe("POST /api/lms/provider-configs — validation", () => {
  it("rejects non-HTTPS base_url (400)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        {
          method: "POST",
          body: { ...VALID_CREATE_BODY, base_url: "http://canvas.example.edu" },
        },
      ),
    );
    expect(res.status).toBe(400);
    expect(db.inserts("lms_provider_configs").length).toBe(0);
  });

  it("rejects base_url with a path (400)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        {
          method: "POST",
          body: {
            ...VALID_CREATE_BODY,
            base_url: "https://canvas.example.edu/login",
          },
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed URLs (400)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        { method: "POST", body: { ...VALID_CREATE_BODY, base_url: "not-a-url" } },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/lms/provider-configs — happy paths", () => {
  it("super_admin creates a fresh config and audits the change", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        { method: "POST", body: VALID_CREATE_BODY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { id: string; base_url: string; enabled: boolean };
    }>(res);
    expect(body.data.base_url).toBe("https://canvas.example.edu");
    expect(body.data.enabled).toBe(true);

    // Persisted row exists.
    const inserts = db.inserts("lms_provider_configs");
    expect(inserts.length).toBe(1);

    // Audit row written.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.provider_config.updated");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"provider_id":"canvas"');
    expect(metadata).toContain('"created":true');
    expect(metadata).toContain('"enabled":true');
    expect(metadata).toContain('"probed":false');
  });

  it("university_admin updates their own config (UPDATE not INSERT)", async () => {
    const db = makeDb([seedCanvasRow(UNI_A)]);
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "POST",
          body: {
            ...VALID_CREATE_BODY,
            base_url: "https://canvas-new.example.edu",
            enabled: false,
          },
        },
      ),
    );
    expect(res.status).toBe(200);
    const updates = db.updates("lms_provider_configs");
    expect(updates.length).toBe(1);
    expect(updates[0]!.params[0]).toBe("https://canvas-new.example.edu");
    expect(updates[0]!.params[1]).toBe(0); // enabled flag flipped to 0
    expect(db.inserts("lms_provider_configs").length).toBe(0);

    const audits = db.inserts("audit_logs");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"created":false');
    expect(metadata).toContain('"enabled":false');
  });
});

describe("POST /api/lms/provider-configs — test_pat probe", () => {
  it("happy probe: probes /api/v1/users/self with the supplied PAT, persists when 200", async () => {
    const db = makeDb();
    const fake = async (input: string, init: RequestInit) => {
      expect(input).toBe("https://canvas.example.edu/api/v1/users/self");
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toBe("Bearer admin-test-token");
      return new Response(JSON.stringify({ id: 4242 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await withMockedFetch(fake, () =>
      handleUpsertLmsProviderConfig(
        ctxWith(
          db,
          { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
          {
            method: "POST",
            body: { ...VALID_CREATE_BODY, test_pat: "admin-test-token" },
          },
        ),
      ),
    );
    expect(res.status).toBe(200);

    // Row persisted.
    expect(db.inserts("lms_provider_configs").length).toBe(1);

    // The test PAT must NOT show up anywhere on disk or in the response.
    const serialized = JSON.stringify(await res.clone().json());
    expect(serialized).not.toContain("admin-test-token");
    const inserts = db.inserts("lms_provider_configs");
    for (const insert of inserts) {
      for (const p of insert.params) {
        expect(typeof p === "string" ? p : "").not.toContain(
          "admin-test-token",
        );
      }
    }
    // Audit metadata records that the probe ran but never the token value.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"probed":true');
    expect(metadata).not.toContain("admin-test-token");
  });

  it("rejects with `invalid_token` when Canvas returns 401, persists nothing", async () => {
    const db = makeDb();
    const fake = async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({ errors: ["unauthorized"] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const res = await withMockedFetch(fake, () =>
      handleUpsertLmsProviderConfig(
        ctxWith(
          db,
          { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
          {
            method: "POST",
            body: { ...VALID_CREATE_BODY, test_pat: "bogus" },
          },
        ),
      ),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("invalid_token");
    expect(db.inserts("lms_provider_configs").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE — RBAC + tenant cloak + audit
// ---------------------------------------------------------------------------

describe("DELETE /api/lms/provider-configs/:id", () => {
  it("requires authentication", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(db, null, {
        method: "DELETE",
        path: `/api/lms/provider-configs/${seed.id}`,
      }),
      seed.id,
    );
    expect(res.status).toBe(401);
    expect(db.executions.filter((e) => e.normalizedSql.startsWith("DELETE"))).toHaveLength(0);
  });

  it("rejects non-admin roles (403)", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        { id: STUDENT_ID, role: "student", university_id: UNI_A },
        { method: "DELETE", path: `/api/lms/provider-configs/${seed.id}` },
      ),
      seed.id,
    );
    expect(res.status).toBe(403);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("returns 404 for unknown id", async () => {
    const db = makeDb();
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        { method: "DELETE" },
      ),
      "00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (cloak) when university_admin targets a row in another tenant — no audit", async () => {
    const seed = seedCanvasRow(UNI_B);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        { method: "DELETE", path: `/api/lms/provider-configs/${seed.id}` },
      ),
      seed.id,
    );
    expect(res.status).toBe(404);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("super_admin deletes any row + writes an audit entry", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_B },
        { method: "DELETE", path: `/api/lms/provider-configs/${seed.id}` },
      ),
      seed.id,
    );
    expect(res.status).toBe(200);

    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.provider_config.removed");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"provider_id":"canvas"');
  });

  it("university_admin deletes their own row + writes an audit entry", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        { method: "DELETE", path: `/api/lms/provider-configs/${seed.id}` },
      ),
      seed.id,
    );
    expect(res.status).toBe(200);
    expect(db.inserts("audit_logs").length).toBe(1);
  });

  it("university_admin from another tenant cannot delete (404 cloak path)", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleDeleteLmsProviderConfig(
      ctxWith(
        db,
        {
          id: UNI_ADMIN_B_ID,
          role: "university_admin",
          university_id: UNI_B,
        },
        { method: "DELETE", path: `/api/lms/provider-configs/${seed.id}` },
      ),
      seed.id,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/lms/provider-configs/enabled (UNI-54) — public listing
// ---------------------------------------------------------------------------

describe("GET /api/lms/provider-configs/enabled — public listing", () => {
  it("requires authentication (401)", async () => {
    const res = await handleListEnabledLmsProviders(ctxWith(makeDb(), null));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the caller has no university", async () => {
    const res = await handleListEnabledLmsProviders(
      ctxWith(makeDb(), {
        id: "00000000-0000-0000-0000-00000000eeee",
        role: "guest",
        university_id: null,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("allows non-admin roles (faculty, teacher, student, staff, TA, viewer)", async () => {
    const seed = seedCanvasRow(UNI_A);
    for (const role of [
      "faculty",
      "teacher",
      "teacher_assistant",
      "student",
      "staff",
      "viewer",
    ] as const) {
      const db = makeDb([seed]);
      const res = await handleListEnabledLmsProviders(
        ctxWith(db, {
          id: "00000000-0000-0000-0000-00000000ffff",
          role,
          university_id: UNI_A,
        }),
      );
      expect(res.status, `role=${role}`).toBe(200);
      const body = await jsonBody<{
        data: { providers: Array<{ provider_id: string }> };
      }>(res);
      expect(body.data.providers).toHaveLength(1);
      expect(body.data.providers[0]!.provider_id).toBe("canvas");
    }
  });

  it("response shape carries no admin-only fields", async () => {
    const seed = seedCanvasRow(UNI_A);
    const db = makeDb([seed]);
    const res = await handleListEnabledLmsProviders(
      ctxWith(db, {
        id: "00000000-0000-0000-0000-00000000ffff",
        role: "faculty",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());

    expect(serialized).not.toMatch(/"client_id"/);
    expect(serialized).not.toMatch(/"client_secret"/);
    expect(serialized).not.toMatch(/"configured_by_user_id"/);
    expect(serialized).not.toMatch(/"configured_at"/);

    expect(serialized).toContain('"provider_id":"canvas"');
    expect(serialized).toContain('"display_name":"Canvas"');
    expect(serialized).toContain('"base_url":"https://canvas.example.edu"');
  });

  it("filters out disabled rows", async () => {
    const seed = { ...seedCanvasRow(UNI_A), enabled: 0 };
    const db = makeDb([seed]);
    const res = await handleListEnabledLmsProviders(
      ctxWith(db, {
        id: "00000000-0000-0000-0000-00000000ffff",
        role: "faculty",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { providers: unknown[] } }>(res);
    expect(body.data.providers).toEqual([]);
  });
});
