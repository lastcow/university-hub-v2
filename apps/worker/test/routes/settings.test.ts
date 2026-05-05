// Route tests for settings (UNI-15). Focus areas:
//   - Mailgun status returns NO secret values, only status strings + region.
//   - System status reports a sane summary without leaking secrets.
//   - University settings PATCH is gated to super_admin / that uni's admin
//     and emits a `settings.updated` audit row on success.
//   - Account settings PATCH rejects with `wrong_current_password` when the
//     current password is wrong; succeeds when it's right; emits the
//     corresponding audit row in both cases.

import { describe, expect, it } from "vitest";

import { hashPassword } from "../../src/auth/password.js";
import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleGetMailgunStatus,
  handleGetSystemSettings,
  handleGetSystemStatus,
  handleUpdateAccountSettings,
  handleUpdateSystemSettings,
  handleUpdateUniversitySettings,
} from "../../src/routes/settings.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const STUDENT_ID = "00000000-0000-0000-0000-00000000cccc";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

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

function makeUniDb(seed = [uniRow(UNI_A, "Uni A", "uni-a"), uniRow(UNI_B, "Uni B", "uni-b")]) {
  const db = new ProgrammableD1();
  const byId = new Map(seed.map((u) => [u.id, { ...u }]));
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok")) return { ok: 1 };
    if (
      sql.startsWith("SELECT id, name, slug, status") &&
      sql.includes("WHERE id = ? LIMIT 1")
    ) {
      return byId.get(String(params[0])) ?? null;
    }
    if (sql.includes("FROM universities WHERE slug = ?")) {
      return null;
    }
    return undefined;
  });
  return db;
}

const PLACEHOLDER_ENV: Env = {
  DB: undefined as unknown as D1Database,
  ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  // Placeholder sentinels — every required var is "Missing configuration".
  MAILGUN_API_KEY: "replace-with-mailgun-api-key",
  MAILGUN_DOMAIN: "replace-with-mailgun-domain",
  MAILGUN_FROM_EMAIL: "replace-with-from-email",
  MAILGUN_FROM_NAME: "replace-with-from-name",
};

const CONFIGURED_ENV: Env = {
  DB: undefined as unknown as D1Database,
  ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
  APP_ENV: "production",
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  MAILGUN_API_KEY: "key-supersecretvalue-1234",
  MAILGUN_DOMAIN: "mg.example.com",
  MAILGUN_FROM_EMAIL: "no-reply@mg.example.com",
  MAILGUN_FROM_NAME: "University Hub",
  MAILGUN_REGION: "EU",
};

function ctxWith(env: Env, db: ProgrammableD1, actor: Partial<UserRow> & Pick<UserRow, "id" | "role">, init?: { method?: string; body?: unknown; path?: string }): RequestContext {
  const url = new URL(`https://hub.example.com${init?.path ?? "/api/settings/system-status"}`);
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  const auth: AuthState = {
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
  };
  return {
    request: new Request(url, requestInit),
    env: { ...env, DB: db as unknown as D1Database },
    url,
    cookies: {},
    auth,
  };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/settings/mailgun-status — never leaks secrets", () => {
  it("returns Missing configuration for placeholder vars and no values", async () => {
    const db = makeUniDb();
    const res = handleGetMailgunStatus(
      ctxWith(PLACEHOLDER_ENV, db, { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        configured: boolean;
        variables: Array<{ key: string; status: string; value: string | null; optional: boolean }>;
      };
    }>(res);
    expect(body.data.configured).toBe(false);

    const required = body.data.variables.filter((v) => !v.optional);
    expect(required.every((v) => v.status === "Missing configuration")).toBe(true);
    expect(required.every((v) => v.value === null)).toBe(true);

    // Hard guarantee: response body must not contain ANY of the secret values
    // even by accident.
    const json = JSON.stringify(body);
    expect(json).not.toContain("replace-with-mailgun-api-key");
    expect(json).not.toContain("replace-with-mailgun-domain");
    expect(json).not.toContain("replace-with-from-email");
    expect(json).not.toContain("replace-with-from-name");
  });

  it("returns Configured for real values and never echoes the api key", async () => {
    const db = makeUniDb();
    const res = handleGetMailgunStatus(
      ctxWith(CONFIGURED_ENV, db, { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    const body = await jsonBody<{
      data: {
        configured: boolean;
        variables: Array<{ key: string; status: string; value: string | null; optional: boolean }>;
      };
    }>(res);
    expect(body.data.configured).toBe(true);
    const required = body.data.variables.filter((v) => !v.optional);
    expect(required.every((v) => v.status === "Configured")).toBe(true);
    // Required vars carry no value — only the status string.
    expect(required.every((v) => v.value === null)).toBe(true);

    // Region IS surfaced as a plain value (not a secret).
    const region = body.data.variables.find((v) => v.key === "MAILGUN_REGION");
    expect(region?.status).toBe("Configured");
    expect(region?.value).toBe("EU");

    // Belt-and-braces: the secret values must not appear in the body.
    const json = JSON.stringify(body);
    expect(json).not.toContain("key-supersecretvalue-1234");
    expect(json).not.toContain("mg.example.com");
    expect(json).not.toContain("no-reply@mg.example.com");
  });

  it("requires authentication", async () => {
    const url = new URL("https://hub.example.com/api/settings/mailgun-status");
    const res = handleGetMailgunStatus({
      request: new Request(url),
      env: { ...PLACEHOLDER_ENV, DB: makeUniDb() as unknown as D1Database },
      url,
      cookies: {},
      auth: null,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-super_admin (university_admin, faculty, student, ...)", async () => {
    const db = makeUniDb();
    for (const role of [
      "university_admin",
      "staff",
      "faculty",
      "teacher",
      "teacher_assistant",
      "student",
      "viewer",
      "guest",
    ] as const) {
      const res = handleGetMailgunStatus(
        ctxWith(CONFIGURED_ENV, db, { id: UNI_ADMIN_ID, role }),
      );
      expect(res.status).toBe(403);
      const body = await jsonBody<{ error: { code: string } }>(res);
      expect(body.error.code).toBe("forbidden");
    }
  });
});

describe("GET /api/settings/system-status", () => {
  it("returns env metadata without exposing secrets", async () => {
    const db = makeUniDb();
    const res = await handleGetSystemStatus(
      ctxWith(CONFIGURED_ENV, db, { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        app_env: string;
        app_name: string;
        app_base_url: string | null;
        mailgun_configured: boolean;
        database_ok: boolean;
      };
    }>(res);
    expect(body.data.app_env).toBe("production");
    expect(body.data.mailgun_configured).toBe(true);
    expect(body.data.database_ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("key-supersecretvalue-1234");
  });
});

describe("PATCH /api/settings/university — RBAC + audit", () => {
  it("rejects non-admin (403) and writes no audit row", async () => {
    const db = makeUniDb();
    const res = await handleUpdateUniversitySettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }, {
        method: "PATCH",
        body: { name: "Renamed" },
      }),
    );
    expect(res.status).toBe(403);
    expect(db.updates("universities").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("rejects a university_admin editing a sibling university (403)", async () => {
    const db = makeUniDb();
    const res = await handleUpdateUniversitySettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_B,
      }, {
        method: "PATCH",
        body: { name: "Renamed" },
        path: `/api/settings/university?university_id=${UNI_A}`,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("succeeds for university_admin on their own uni and writes settings.updated audit row", async () => {
    const db = makeUniDb();
    const res = await handleUpdateUniversitySettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_A,
      }, {
        method: "PATCH",
        body: { name: "Renamed" },
      }),
    );
    expect(res.status).toBe(200);
    expect(db.updates("universities").length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("settings.updated");
  });
});

describe("PATCH /api/settings/account — password verification", () => {
  it("rejects when current password is wrong, no UPDATE, audit denied row", async () => {
    const db = makeUniDb();
    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
      }, {
        method: "PATCH",
        body: {
          current_password: "wrong-password",
          new_password: "new-secret-1",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonBody<{ ok: false; error: { code: string } }>(res);
    expect(body.error.code).toBe("wrong_current_password");
    expect(db.updates("users").length).toBe(0);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("settings.updated");
    const meta = JSON.parse(String(audits[0]!.params[6])) as {
      denied?: boolean;
      reason?: string;
    };
    expect(meta.denied).toBe(true);
    expect(meta.reason).toBe("wrong_current_password");
  });

  it("succeeds when current password is correct, writes UPDATE + settings.updated audit", async () => {
    const db = makeUniDb();
    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
      }, {
        method: "PATCH",
        body: {
          current_password: "correct-horse",
          new_password: "battery-staple",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(db.updates("users").length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("settings.updated");
  });

  it("name-only update doesn't require password fields", async () => {
    const db = makeUniDb();
    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
        name: "Old Name",
      }, {
        method: "PATCH",
        body: { name: "New Name" },
      }),
    );
    expect(res.status).toBe(200);
    expect(db.updates("users").length).toBe(1);
  });

  it("passing only new_password without current_password is rejected (400)", async () => {
    const db = makeUniDb();
    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
      }, {
        method: "PATCH",
        body: { new_password: "battery-staple" },
      }),
    );
    expect(res.status).toBe(400);
    expect(db.updates("users").length).toBe(0);
  });

  it("UNI-47: password change revokes the user's trusted devices and audits per row", async () => {
    const db = makeUniDb();
    // Seed two trusted-device rows for the actor.
    db.onAll((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("user_id = ?") &&
        params[0] === STUDENT_ID
      ) {
        return [{ id: "td-1" }, { id: "td-2" }];
      }
      return undefined;
    });

    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
      }, {
        method: "PATCH",
        body: {
          current_password: "correct-horse",
          new_password: "battery-staple",
        },
      }),
    );
    expect(res.status).toBe(200);
    // The bulk DELETE for trusted-device rows ran.
    const bulkDelete = db.executions.filter((e) =>
      /^DELETE FROM trusted_devices WHERE user_id = \?/i.test(e.sql),
    );
    expect(bulkDelete.length).toBe(1);
    // One audit row per revoked trusted device, plus the settings.updated row.
    const audits = db.inserts("audit_logs");
    const revokeAudits = audits.filter(
      (e) => e.params[3] === "mfa.trusted_device_revoked",
    );
    expect(revokeAudits.length).toBe(2);
    for (const row of revokeAudits) {
      expect(String(row.params[6])).toContain('"reason":"password_changed"');
    }
    const settingsAudits = audits.filter(
      (e) => e.params[3] === "settings.updated",
    );
    expect(settingsAudits.length).toBe(1);
  });

  it("UNI-47: name-only update does NOT revoke trusted devices", async () => {
    const db = makeUniDb();
    db.onAll((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("user_id = ?") &&
        params[0] === STUDENT_ID
      ) {
        return [{ id: "td-1" }];
      }
      return undefined;
    });

    const passwordHash = await hashPassword("correct-horse");
    const res = await handleUpdateAccountSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
        password_hash: passwordHash,
        name: "Old Name",
      }, {
        method: "PATCH",
        body: { name: "New Name" },
      }),
    );
    expect(res.status).toBe(200);
    const bulkDelete = db.executions.filter((e) =>
      /^DELETE FROM trusted_devices WHERE user_id = \?/i.test(e.sql),
    );
    expect(bulkDelete.length).toBe(0);
    const audits = db.inserts("audit_logs");
    expect(
      audits.filter((e) => e.params[3] === "mfa.trusted_device_revoked").length,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UNI-47: System settings RBAC + side effects
// ---------------------------------------------------------------------------

describe("/api/settings/system — UNI-47", () => {
  function makeSystemDb(initialDays: string = "30"): ProgrammableD1 {
    const db = new ProgrammableD1();
    let value = initialDays;
    db.onFirst((sql, params) => {
      if (sql.startsWith("SELECT 1 AS ok")) return { ok: 1 };
      if (sql.includes("FROM system_settings") && sql.includes("WHERE key = ?")) {
        if (params[0] === "mfa_trusted_device_days") {
          return { key: "mfa_trusted_device_days", value };
        }
        return null;
      }
      return undefined;
    });
    db.onWrite((sql, params) => {
      const lower = sql.toLowerCase();
      if (lower.startsWith("insert into system_settings")) {
        // Param order: key, value, updated_by_user_id, created_at, updated_at
        if (params[0] === "mfa_trusted_device_days") {
          value = String(params[1]);
        }
      }
    });
    return db;
  }

  it("GET 200 for super_admin and university_admin; 403 otherwise", async () => {
    const db = makeSystemDb();
    const okSuper = await handleGetSystemSettings(
      ctxWith(CONFIGURED_ENV, db, { id: SUPER_ADMIN_ID, role: "super_admin" }),
    );
    expect(okSuper.status).toBe(200);
    const okUni = await handleGetSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(okUni.status).toBe(200);
    const denied = await handleGetSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: STUDENT_ID,
        role: "student",
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("PATCH refuses university_admin even on its own university (super_admin only)", async () => {
    const db = makeSystemDb();
    const res = await handleUpdateSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_A,
      }, {
        method: "PATCH",
        body: { mfa_trusted_device_days: 7 },
      }),
    );
    expect(res.status).toBe(403);
    // Audit row recorded the denial.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("settings.updated");
    const meta = JSON.parse(String(audits[0]!.params[6])) as {
      denied?: boolean;
      scope?: string;
    };
    expect(meta.denied).toBe(true);
    expect(meta.scope).toBe("system");
  });

  it("PATCH succeeds for super_admin and audits with from/to", async () => {
    const db = makeSystemDb("30");
    const res = await handleUpdateSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: SUPER_ADMIN_ID,
        role: "super_admin",
      }, {
        method: "PATCH",
        body: { mfa_trusted_device_days: 14 },
      }),
    );
    expect(res.status).toBe(200);
    const audits = db.inserts("audit_logs");
    const settingsAudits = audits.filter(
      (e) => e.params[3] === "settings.updated",
    );
    expect(settingsAudits.length).toBe(1);
    const meta = JSON.parse(String(settingsAudits[0]!.params[6])) as {
      changed?: { mfa_trusted_device_days?: { from: number; to: number } };
    };
    expect(meta.changed?.mfa_trusted_device_days).toEqual({ from: 30, to: 14 });
  });

  it("PATCH rejects out-of-range values (zod min/max)", async () => {
    const db = makeSystemDb();
    const tooLow = await handleUpdateSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: SUPER_ADMIN_ID,
        role: "super_admin",
      }, {
        method: "PATCH",
        body: { mfa_trusted_device_days: 0 },
      }),
    );
    expect(tooLow.status).toBe(400);
    const tooHigh = await handleUpdateSystemSettings(
      ctxWith(CONFIGURED_ENV, db, {
        id: SUPER_ADMIN_ID,
        role: "super_admin",
      }, {
        method: "PATCH",
        body: { mfa_trusted_device_days: 999 },
      }),
    );
    expect(tooHigh.status).toBe(400);
  });
});
