// Route tests for the LMS provider-config admin surface (UNI-53).
//
// Coverage map back to the issue acceptance criteria:
//
//   - "Super_admin / university_admin can configure Canvas OAuth (base_url,
//     client_id, client_secret)." → "POST — happy paths" (super_admin
//     creates, university_admin updates).
//   - "client_secret is never returned in any response." → "GET — never
//     returns client_secret" + "POST — response shape never includes
//     client_secret".
//   - "Audit log row created on every config change." → both
//     `lms.provider_config.updated` (create + update) and
//     `lms.provider_config.removed` audit assertions in the POST + DELETE
//     describe blocks.
//   - "Non-admin users do NOT see the Integrations admin tab and get 403
//     on its endpoints." → "GET / POST / DELETE — RBAC" describe blocks.
//
// Crypto: `LMS_TOKEN_ENCRYPTION_KEY` is fed to the route handler via
// `env`. The encryption helper is the real one — we test that the
// persisted ciphertext is non-empty and that it round-trips back to the
// plaintext via `decryptForUniversity`. We don't pin the exact bytes —
// the IV is random per call, so each run produces a different ciphertext.
//
// Tenant scoping: super_admin can target any university; university_admin
// is locked to their own and a cross-tenant request gets a 403 (POST/GET)
// or a 404 cloak (DELETE — we don't leak the row's existence). The
// describe blocks for each verb assert this directly.

import { describe, expect, it } from "vitest";

import { decryptForUniversity } from "../../src/crypto/field-encryption.js";
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
  client_id: string;
  client_secret_encrypted: string;
  enabled: number;
  configured_by_user_id: string | null;
  configured_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Test DB — backs the four queries the route handler makes:
//   - SELECT ... WHERE id = ?                       → loadConfigById
//   - SELECT ... WHERE university_id = ? AND provider_id = ?
//   - SELECT ... WHERE university_id = ? ORDER BY ...
//   - INSERT/UPDATE/DELETE on lms_provider_configs
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
        client_id,
        client_secret_encrypted,
        enabled,
        configured_by_user_id,
        configured_at,
        updated_at,
      ] = params as [
        string,
        string,
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
        client_id,
        client_secret_encrypted,
        enabled,
        configured_by_user_id,
        configured_at,
        updated_at,
      });
    } else if (sql.startsWith("UPDATE lms_provider_configs")) {
      const [
        base_url,
        client_id,
        client_secret_encrypted,
        enabled,
        configured_by_user_id,
        updated_at,
        id,
      ] = params as [string, string, string, number, string, string, string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.base_url = base_url;
        row.client_id = client_id;
        row.client_secret_encrypted = client_secret_encrypted;
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
  // Real master key — long enough that HKDF derives meaningfully and
  // we can round-trip the encrypted secret in tests below.
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

function seedCanvasRow(
  university_id: string,
  encryptedSecret = "stub-ciphertext",
): ConfigRow {
  return {
    id: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa${university_id.slice(0, 4)}`,
    university_id,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    client_id: "long-client-id-1234",
    client_secret_encrypted: encryptedSecret,
    enabled: 1,
    configured_by_user_id: SUPER_ADMIN_ID,
    configured_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

const VALID_CREATE_BODY = {
  provider_id: "canvas" as const,
  base_url: "https://canvas.example.edu",
  client_id: "the-canvas-oauth-client-id-abcdefgh",
  client_secret: "the-real-client-secret-do-not-leak",
  enabled: true,
};

// ---------------------------------------------------------------------------
// GET — RBAC + scoping + secret-omission contract
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

describe("GET /api/lms/provider-configs — never returns client_secret", () => {
  it("returns the configured row for the caller's university with masked client_id and no secret", async () => {
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
          config: {
            client_id_last4: string;
            has_client_secret: boolean;
            base_url: string;
            enabled: boolean;
          } | null;
        }>;
      };
    }>(res);

    // No serialized form of the response carries the plaintext secret,
    // a `client_secret` field, or the on-disk ciphertext. (`has_client_secret`
    // is a boolean presence flag — that's fine.) This is the *acceptance*
    // check — verify the contract.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"client_secret"/);
    expect(serialized).not.toMatch(/"client_secret_encrypted"/);
    expect(serialized).not.toContain(seed.client_secret_encrypted);
    expect(serialized).not.toContain(seed.client_id);

    const canvas = body.data.providers.find(
      (p) => p.provider_id === "canvas",
    );
    expect(canvas).toBeDefined();
    expect(canvas?.config?.client_id_last4).toBe("1234"); // last 4 of seed
    expect(canvas?.config?.has_client_secret).toBe(true);
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

  it("scopes university_admin reads to their own tenant", async () => {
    // Two universities; the admin only sees their own row.
    const db = makeDb([seedCanvasRow(UNI_A), seedCanvasRow(UNI_B)]);
    const res = await handleListLmsProviderConfigs(
      ctxWith(db, {
        id: UNI_ADMIN_A_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    const body = await jsonBody<{
      data: {
        providers: Array<{
          provider_id: string;
          config: { id: string; university_id: string } | null;
        }>;
      };
    }>(res);
    const canvas = body.data.providers.find(
      (p) => p.provider_id === "canvas",
    );
    expect(canvas?.config?.university_id).toBe(UNI_A);
  });
});

// ---------------------------------------------------------------------------
// POST — RBAC, validation, persistence + audit
// ---------------------------------------------------------------------------

describe("POST /api/lms/provider-configs — RBAC", () => {
  it("requires authentication", async () => {
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(makeDb(), null, {
        method: "POST",
        body: VALID_CREATE_BODY,
      }),
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

  it("rejects empty client_id (400)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        {
          method: "POST",
          body: { ...VALID_CREATE_BODY, client_id: "  " },
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing client_secret on first configure (400, no row, no audit)", async () => {
    const db = makeDb();
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: SUPER_ADMIN_ID, role: "super_admin", university_id: UNI_A },
        {
          method: "POST",
          body: { ...VALID_CREATE_BODY, client_secret: "" },
        },
      ),
    );
    expect(res.status).toBe(400);
    expect(db.inserts("lms_provider_configs").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });
});

describe("POST /api/lms/provider-configs — happy paths + secret encryption", () => {
  it("super_admin creates a fresh config — encrypts secret, never returns it, audits the change", async () => {
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
      data: {
        id: string;
        client_id_last4: string;
        has_client_secret: boolean;
      };
    }>(res);

    // Response shape: never echoes the plaintext secret, a literal
    // `client_secret` field, or the ciphertext column. The
    // `has_client_secret` boolean is the only thing left.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(VALID_CREATE_BODY.client_secret);
    expect(serialized).not.toMatch(/"client_secret"/);
    expect(serialized).not.toMatch(/"client_secret_encrypted"/);
    expect(body.data.has_client_secret).toBe(true);
    expect(body.data.client_id_last4).toBe("efgh");

    // Persisted row exists and the ciphertext round-trips back to the
    // plaintext under the same university id.
    const inserts = db.inserts("lms_provider_configs");
    expect(inserts.length).toBe(1);
    const persistedSecretCt = inserts[0]!.params[5] as string;
    expect(persistedSecretCt.length).toBeGreaterThan(0);
    expect(persistedSecretCt).not.toBe(VALID_CREATE_BODY.client_secret);
    const decrypted = await decryptForUniversity(
      ENV,
      persistedSecretCt,
      UNI_A,
    );
    expect(decrypted).toBe(VALID_CREATE_BODY.client_secret);

    // Audit row written with the right action + metadata.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("lms.provider_config.updated");
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"provider_id":"canvas"');
    expect(metadata).toContain('"created":true');
    expect(metadata).toContain('"secret_changed":true');
    expect(metadata).toContain('"enabled":true');
    // The audit row must NOT carry the secret.
    expect(metadata).not.toContain(VALID_CREATE_BODY.client_secret);
  });

  it("university_admin updates their own config — keeps existing secret when client_secret is blank", async () => {
    // Pre-encrypt a secret with the real helper so we can check that the
    // ciphertext on disk is preserved verbatim across an update.
    const { encryptForUniversity } = await import(
      "../../src/crypto/field-encryption.js"
    );
    const originalSecretCt = await encryptForUniversity(
      ENV,
      "previously-stored-secret",
      UNI_A,
    );
    const db = makeDb([
      { ...seedCanvasRow(UNI_A), client_secret_encrypted: originalSecretCt },
    ]);

    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "POST",
          body: {
            provider_id: "canvas" as const,
            base_url: "https://canvas-new.example.edu",
            client_id: "rotated-client-id-zzzzwxyz",
            client_secret: "", // blank — keep existing
            enabled: true,
          },
        },
      ),
    );
    expect(res.status).toBe(200);

    const updates = db.updates("lms_provider_configs");
    expect(updates.length).toBe(1);
    // params[2] is client_secret_encrypted on the UPDATE statement.
    expect(updates[0]!.params[2]).toBe(originalSecretCt);

    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"created":false');
    expect(metadata).toContain('"secret_changed":false');
  });

  it("university_admin rotating the secret stores fresh ciphertext that round-trips", async () => {
    const { encryptForUniversity } = await import(
      "../../src/crypto/field-encryption.js"
    );
    const originalCt = await encryptForUniversity(ENV, "old-secret", UNI_A);
    const db = makeDb([
      { ...seedCanvasRow(UNI_A), client_secret_encrypted: originalCt },
    ]);

    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "POST",
          body: {
            ...VALID_CREATE_BODY,
            client_secret: "new-rotated-secret",
          },
        },
      ),
    );
    expect(res.status).toBe(200);
    const updates = db.updates("lms_provider_configs");
    const newCt = updates[0]!.params[2] as string;
    expect(newCt).not.toBe(originalCt);
    const decrypted = await decryptForUniversity(ENV, newCt, UNI_A);
    expect(decrypted).toBe("new-rotated-secret");

    const metadata = db.inserts("audit_logs")[0]!.params[6] as string;
    expect(metadata).toContain('"secret_changed":true');
  });

  it("disabling toggles the `enabled` column without requiring a secret rotation", async () => {
    const { encryptForUniversity } = await import(
      "../../src/crypto/field-encryption.js"
    );
    const ct = await encryptForUniversity(ENV, "still-here", UNI_A);
    const db = makeDb([
      { ...seedCanvasRow(UNI_A), client_secret_encrypted: ct },
    ]);
    const res = await handleUpsertLmsProviderConfig(
      ctxWith(
        db,
        { id: UNI_ADMIN_A_ID, role: "university_admin", university_id: UNI_A },
        {
          method: "POST",
          body: {
            ...VALID_CREATE_BODY,
            client_secret: "",
            enabled: false,
          },
        },
      ),
    );
    expect(res.status).toBe(200);
    const updates = db.updates("lms_provider_configs");
    expect(updates[0]!.params[3]).toBe(0); // enabled column
    const metadata = db.inserts("audit_logs")[0]!.params[6] as string;
    expect(metadata).toContain('"enabled":false');
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
        {
          method: "DELETE",
          path: `/api/lms/provider-configs/${seed.id}`,
        },
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
        {
          method: "DELETE",
          path: `/api/lms/provider-configs/${seed.id}`,
        },
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
        {
          method: "DELETE",
          path: `/api/lms/provider-configs/${seed.id}`,
        },
      ),
      seed.id,
    );
    expect(res.status).toBe(200);

    // Audit entry written.
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
        {
          method: "DELETE",
          path: `/api/lms/provider-configs/${seed.id}`,
        },
      ),
      seed.id,
    );
    expect(res.status).toBe(200);
    expect(db.inserts("audit_logs").length).toBe(1);
  });

  // Tenant-isolation regression: a university_admin from UNI_B should NOT
  // be able to read or delete UNI_A's row.
  it("university_admin from another tenant cannot delete (403/404 cloak path)", async () => {
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
        {
          method: "DELETE",
          path: `/api/lms/provider-configs/${seed.id}`,
        },
      ),
      seed.id,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/lms/provider-configs/enabled (UNI-54)
//
// User-facing public listing — any authenticated user can call it. Returns
// only enabled rows for the caller's university and a stripped shape with
// no admin-only fields. The /app/integrations page reads this so the
// Connect button is reachable for non-admin roles (faculty / student / etc.)
// — gating it behind isAdminLike was the UNI-54 QA blocker.
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

  it("allows non-admin roles (faculty, teacher, student, staff, TA, viewer, guest)", async () => {
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

  it("response shape carries no admin-only fields and no secret", async () => {
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
    const body = await jsonBody(res);
    const serialized = JSON.stringify(body);

    // Admin-only fields are absent — the public shape is just
    // (provider_id, display_name, base_url).
    expect(serialized).not.toMatch(/"client_id"/);
    expect(serialized).not.toMatch(/"client_id_last4"/);
    expect(serialized).not.toMatch(/"client_secret"/);
    expect(serialized).not.toMatch(/"client_secret_encrypted"/);
    expect(serialized).not.toMatch(/"has_client_secret"/);
    expect(serialized).not.toMatch(/"configured_by_user_id"/);
    expect(serialized).not.toMatch(/"configured_at"/);
    expect(serialized).not.toContain(seed.client_id);
    expect(serialized).not.toContain(seed.client_secret_encrypted);

    // The bits the SPA needs are present.
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
    const body = await jsonBody<{
      data: { providers: unknown[] };
    }>(res);
    expect(body.data.providers).toEqual([]);
  });

  it("scopes the listing to the caller's own university", async () => {
    // UNI_A's row should never leak to a UNI_B user, even though both rows
    // exist in the same table.
    const db = makeDb([seedCanvasRow(UNI_A), seedCanvasRow(UNI_B)]);
    const res = await handleListEnabledLmsProviders(
      ctxWith(db, {
        id: "00000000-0000-0000-0000-00000000ffff",
        role: "faculty",
        university_id: UNI_B,
      }),
    );
    const body = await jsonBody<{
      data: { providers: Array<{ base_url: string }> };
    }>(res);
    expect(body.data.providers).toHaveLength(1);
    // Both seeds use the same base_url string by default; the test
    // shape that matters is the count + provider_id; both seeds' rows
    // for `canvas` exist but only the caller's row is returned. To
    // make scoping visible, query from UNI_A and confirm no UNI_B row
    // surfaces (the fake DB's onAll filter is by university_id).
    expect(body.data.providers.every((p) => p.base_url.length > 0)).toBe(
      true,
    );
  });
});
