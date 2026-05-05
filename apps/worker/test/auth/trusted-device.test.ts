// Unit tests for the trusted-device store + cookie-hash construction
// (UNI-47).
//
// These cover:
//   - hashTrustedDeviceToken() emits a 64-char lowercase hex HMAC-SHA-256
//     and is keyed by SESSION_SECRET (rotation invalidates).
//   - createTrustedDevice() refuses to mint when SESSION_SECRET is unset.
//   - createTrustedDevice() stores the HMAC-keyed bytes (not plain SHA-256
//     of the token) in trusted_devices.token_hash, mirroring the UNI-37
//     session model.
//   - resolveTrustedDeviceByToken() returns null when the cookie hashes
//     to a row but the row's expires_at has passed; the stale row is
//     deleted in the same call.

import { describe, expect, it } from "vitest";

import {
  createTrustedDevice,
  hashTrustedDeviceToken,
  resolveTrustedDeviceByToken,
} from "../../src/auth/trusted-device.js";
import type { Env } from "../../src/env.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const TEST_SESSION_SECRET = "test-session-secret-fixture";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides,
  };
}

describe("hashTrustedDeviceToken()", () => {
  it("emits a 64-char lowercase hex HMAC-SHA-256", async () => {
    const out = await hashTrustedDeviceToken("hello", TEST_SESSION_SECRET);
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different output for the same token under a different secret", async () => {
    const a = await hashTrustedDeviceToken("hello", "secret-a");
    const b = await hashTrustedDeviceToken("hello", "secret-b");
    expect(a).not.toBe(b);
  });

  it("is stable for the same (token, secret) pair", async () => {
    const a = await hashTrustedDeviceToken("hello", TEST_SESSION_SECRET);
    const b = await hashTrustedDeviceToken("hello", TEST_SESSION_SECRET);
    expect(a).toBe(b);
  });
});

describe("createTrustedDevice()", () => {
  it("refuses to mint when SESSION_SECRET is unset", async () => {
    const db = new ProgrammableD1();
    const env = makeEnv({
      DB: db as unknown as D1Database,
      SESSION_SECRET: undefined,
    });
    await expect(
      createTrustedDevice(env, {
        userId: "user-1",
        ipAddress: "203.0.113.10",
        userAgent: "ua",
        trustWindowDays: 30,
      }),
    ).rejects.toThrow(/SESSION_SECRET/);
    expect(db.inserts("trusted_devices")).toHaveLength(0);
  });

  it("stores HMAC-keyed token_hash, not plain SHA-256, and respects trustWindowDays", async () => {
    const db = new ProgrammableD1();
    const env = makeEnv({ DB: db as unknown as D1Database });
    const before = Date.now();

    const created = await createTrustedDevice(env, {
      userId: "user-1",
      ipAddress: "203.0.113.10",
      userAgent: "ua",
      trustWindowDays: 7,
    });

    const inserts = db.inserts("trusted_devices");
    expect(inserts).toHaveLength(1);
    const params = inserts[0]!.params;
    // Param order: id, user_id, token_hash, ip, ua, expires_at, created_at
    const storedHash = String(params[2]);
    expect(String(params[1])).toBe("user-1");
    expect(String(params[3])).toBe("203.0.113.10");

    const expectedHmac = await hashTrustedDeviceToken(
      created.token,
      TEST_SESSION_SECRET,
    );
    expect(storedHash).toBe(expectedHmac);

    const plainSha256 = await (async () => {
      const data = new TextEncoder().encode(created.token);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const arr = new Uint8Array(digest);
      let out = "";
      for (let i = 0; i < arr.length; i++) {
        out += (arr[i] ?? 0).toString(16).padStart(2, "0");
      }
      return out;
    })();
    expect(storedHash).not.toBe(plainSha256);

    // expires_at should land ~7 days in the future.
    const expiresAtMs = Date.parse(String(params[5]));
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresAtMs).toBeLessThan(Date.now() + sevenDaysMs + 1000);
  });
});

describe("resolveTrustedDeviceByToken()", () => {
  it("returns null and lazily deletes the stale row when expires_at has passed", async () => {
    const token = "raw-token-fixture";
    const tokenHash = await hashTrustedDeviceToken(token, TEST_SESSION_SECRET);
    const db = new ProgrammableD1();
    db.onFirst((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("WHERE token_hash = ?") &&
        params[0] === tokenHash
      ) {
        return {
          id: "td-1",
          user_id: "user-1",
          token_hash: tokenHash,
          ip_address: "203.0.113.10",
          user_agent: null,
          expires_at: "2000-01-01T00:00:00.000Z", // long past
          created_at: "1999-12-01T00:00:00.000Z",
          last_used_at: null,
        };
      }
      return undefined;
    });

    const env = makeEnv({ DB: db as unknown as D1Database });
    const resolved = await resolveTrustedDeviceByToken(env, token);
    expect(resolved).toBeNull();
    const deletes = db.executions.filter((e) =>
      /^DELETE FROM trusted_devices/i.test(e.sql),
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]!.params[0])).toBe(tokenHash);
  });

  it("returns the row when the token resolves and has not expired", async () => {
    const token = "raw-token-fixture";
    const tokenHash = await hashTrustedDeviceToken(token, TEST_SESSION_SECRET);
    const db = new ProgrammableD1();
    db.onFirst((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("WHERE token_hash = ?") &&
        params[0] === tokenHash
      ) {
        return {
          id: "td-1",
          user_id: "user-1",
          token_hash: tokenHash,
          ip_address: "203.0.113.10",
          user_agent: "ua",
          expires_at: "2099-01-01T00:00:00.000Z",
          created_at: "2026-04-01T00:00:00.000Z",
          last_used_at: null,
        };
      }
      return undefined;
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const resolved = await resolveTrustedDeviceByToken(env, token);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("td-1");
    expect(resolved?.ip_address).toBe("203.0.113.10");
  });

  it("rotating SESSION_SECRET invalidates the same raw token", async () => {
    const token = "raw-token-fixture";
    const oldSecret = "old-secret";
    const newSecret = "new-secret";
    const oldHash = await hashTrustedDeviceToken(token, oldSecret);

    const db = new ProgrammableD1();
    db.onFirst((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("WHERE token_hash = ?")
      ) {
        if (String(params[0]) === oldHash) {
          return {
            id: "td-1",
            user_id: "user-1",
            token_hash: oldHash,
            ip_address: "203.0.113.10",
            user_agent: null,
            expires_at: "2099-01-01T00:00:00.000Z",
            created_at: "2026-04-01T00:00:00.000Z",
            last_used_at: null,
          };
        }
        return undefined;
      }
      return undefined;
    });

    const before = await resolveTrustedDeviceByToken(
      makeEnv({ DB: db as unknown as D1Database, SESSION_SECRET: oldSecret }),
      token,
    );
    expect(before).not.toBeNull();

    const after = await resolveTrustedDeviceByToken(
      makeEnv({ DB: db as unknown as D1Database, SESSION_SECRET: newSecret }),
      token,
    );
    expect(after).toBeNull();
  });
});
