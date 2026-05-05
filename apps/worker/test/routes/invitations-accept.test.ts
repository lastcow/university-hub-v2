// Invitation-accept MFA enrollment hand-off tests (UNI-60).
//
// Pre-fix the accept endpoint auto-signed the new user in via a session
// cookie, which let them reach `/app/*` without ever enrolling in MFA.
// After UNI-49 made MFA mandatory for every role, that gap left newly-
// invited users stuck in a sign-in ↔ "Sign in again to complete MFA
// verification" loop on their second sign-in (no `mfa_secret` to satisfy
// a TOTP challenge).
//
// The fix mirrors `handleSignIn`'s `mfa_required` branch: invitation
// accept now sets the MFA challenge cookie and returns
// `mfa_enrollment_required: true`. The SPA pivots straight to the MFA-
// enroll step on /sign-in, where verify-enroll mints the real session.
//
// These tests assert the cookie + body shape and confirm we no longer
// write a session row at accept-time.

import { describe, expect, it } from "vitest";

import type {
  AcceptInvitationInput,
  Invitation,
  InvitationAcceptResult,
  Role,
} from "@university-hub/shared";

import { hashInvitationToken } from "../../src/auth/invitation-token.js";
import type { Env } from "../../src/env.js";
import type { RequestContext } from "../../src/middleware/auth.js";
import { handleAcceptInvitation } from "../../src/routes/invitations.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SESSION_SECRET = "test-session-secret-fixture";
const ACCEPT_PASSWORD = "DevPassword!2026";

interface AcceptScenario {
  role: Role;
  /**
   * Optional: drop overrides into the JSON body the SPA would send. Useful
   * for asserting that the role / token mismatch error paths are still
   * exercised after the refactor.
   */
  bodyOverrides?: Partial<AcceptInvitationInput>;
}

interface AcceptResult {
  res: Response;
  body: InvitationAcceptResult | null;
  rawBody: unknown;
  db: ProgrammableD1;
  rawToken: string;
}

interface InvitationFixture extends Invitation {
  token_hash: string;
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
    SESSION_SECRET,
  };
}

function setCookies(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

/** Build a `ProgrammableD1` that satisfies the `handleAcceptInvitation`
 *  read path for a freshly-issued, unaccepted invitation. The mutable
 *  `userInserted` slot lets the post-call assertions verify the user
 *  row was written with `mfa_enabled_at = NULL`. */
function makeAcceptDb(invitation: InvitationFixture): {
  db: ProgrammableD1;
  insertedUser: () => Record<string, unknown> | null;
} {
  const db = new ProgrammableD1();
  let insertedUser: Record<string, unknown> | null = null;
  let userIdAfterInsert: string | null = null;

  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("insert into users ")) {
      // Column order from invitations.ts:
      //  id, email, password_hash, name, role, status, university_id,
      //  last_sign_in_at, created_at, updated_at,
      //  terms_accepted_at, terms_accepted_version
      insertedUser = {
        id: params[0],
        email: params[1],
        password_hash: params[2],
        name: params[3],
        role: params[4],
        // status hardcoded to 'active' in the SQL
        university_id: params[5],
        last_sign_in_at: params[6],
        created_at: params[7],
        updated_at: params[8],
        terms_accepted_at: params[9],
        terms_accepted_version: params[10],
        mfa_secret: null,
        mfa_enabled_at: null,
        mfa_recovery_codes_hash: null,
      };
      userIdAfterInsert = String(params[0]);
    }
  });

  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
      return { ok: 1 };
    }
    if (
      sql.includes("FROM invitations") &&
      sql.includes("WHERE token_hash = ?") &&
      params[0] === invitation.token_hash
    ) {
      return invitation;
    }
    if (
      sql.includes("FROM users") &&
      sql.includes("WHERE email = ?")
    ) {
      // No existing user — accept proceeds to insert.
      return null;
    }
    if (sql.includes("FROM legal_documents")) {
      // No customer override + no global default → handler falls back to v1.
      return null;
    }
    if (sql.includes("FROM universities")) {
      return { name: "Test University" };
    }
    if (
      sql.includes("FROM users") &&
      sql.includes("WHERE id = ?") &&
      params[0] === userIdAfterInsert
    ) {
      // After invitation accept inserts the row, `loadMfaUser` reads it
      // back to feed `issueMfaChallenge` with the MFA columns.
      return insertedUser;
    }
    return undefined;
  });

  return { db, insertedUser: () => insertedUser };
}

async function callAccept(scenario: AcceptScenario): Promise<AcceptResult> {
  const rawToken = "test-invitation-token-value-1234";
  const tokenHash = await hashInvitationToken(rawToken);
  const invitation: InvitationFixture = {
    id: "11111111-1111-1111-1111-111111111111",
    email: `${scenario.role}@example.com`,
    role: scenario.role,
    status: "pending",
    university_id: "22222222-2222-2222-2222-222222222222",
    invited_by: "33333333-3333-3333-3333-333333333333",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    accepted_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    token_hash: tokenHash,
  };

  const { db, insertedUser } = makeAcceptDb(invitation);
  const env = { ...envFor(), DB: db as unknown as D1Database };

  const requestBody: AcceptInvitationInput = {
    token: rawToken,
    email: invitation.email,
    name: `Newly Invited ${scenario.role}`,
    password: ACCEPT_PASSWORD,
    confirmPassword: ACCEPT_PASSWORD,
    terms_accepted: true,
    ...scenario.bodyOverrides,
  };

  const request = new Request("http://localhost/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: {},
    auth: null,
  };

  const res = await handleAcceptInvitation(ctx);
  let parsed: { data?: InvitationAcceptResult } | null = null;
  let body: InvitationAcceptResult | null = null;
  try {
    parsed = (await res.clone().json()) as { data?: InvitationAcceptResult };
    body = parsed?.data ?? null;
  } catch {
    body = null;
  }

  // Allow assertions to inspect the post-state via a fresh DB lookup.
  void insertedUser;

  return { res, body, rawBody: parsed, db, rawToken };
}

describe("POST /api/invitations/accept — UNI-60 MFA enrollment hand-off", () => {
  it("issues an MFA challenge cookie (not a session cookie) for a faculty invite", async () => {
    const { res, body, db } = await callAccept({ role: "faculty" });

    expect(res.status).toBe(201);
    expect(body?.mfa_enrollment_required).toBe(true);
    expect(body?.email).toBe("faculty@example.com");
    expect(body?.role).toBe("faculty");
    expect(body?.user_id).toBeTruthy();
    // Faculty is not always-challenge → eligible for the UNI-49
    // risk-based bypass on subsequent sign-ins.
    expect(body?.trusted_device_eligible).toBe(true);

    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");

    // Persisted state: user row written without MFA, challenge row
    // inserted, no session row.
    expect(db.inserts("users").length).toBe(1);
    expect(db.inserts("mfa_challenges").length).toBe(1);
    expect(db.inserts("sessions").length).toBe(0);
  });

  it("hides the trusted-device option for super_admin invites", async () => {
    const { body } = await callAccept({ role: "super_admin" });
    // super_admin is always-MFA: no "remember this device" affordance.
    expect(body?.trusted_device_eligible).toBe(false);
    expect(body?.mfa_enrollment_required).toBe(true);
  });

  it("keeps the trusted-device option for university_admin invites (UNI-47 cookie path)", async () => {
    const { body } = await callAccept({ role: "university_admin" });
    expect(body?.trusted_device_eligible).toBe(true);
    expect(body?.mfa_enrollment_required).toBe(true);
  });

  it("persists the new user with mfa_enabled_at = NULL so verify-enroll can flip it later", async () => {
    const { db } = await callAccept({ role: "teacher" });
    const userInsert = db.inserts("users")[0];
    expect(userInsert).toBeDefined();
    // The accept endpoint never sets `mfa_enabled_at` directly — that
    // column is only flipped from `handleMfaVerifyEnroll` after the
    // first TOTP code is accepted. The INSERT statement omits the
    // column entirely (defaulting to NULL via the schema).
    expect(userInsert!.normalizedSql).not.toMatch(/mfa_enabled_at/i);
  });

  it("rejects a tampered email even though the rest of the form is valid", async () => {
    const { res, rawBody } = await callAccept({
      role: "faculty",
      bodyOverrides: { email: "attacker@example.com" },
    });
    expect(res.status).toBe(400);
    const err = (rawBody as { error?: { code?: string } } | null)?.error;
    expect(err?.code).toBe("email_mismatch");
    const cookies = setCookies(res).join(" | ");
    expect(cookies).not.toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");
  });
});
