// Route tests for `POST /api/invitations` focused on the UNI-62 contract:
// every non-super_admin invitation must carry a `university_id`, otherwise
// the create endpoint must reject with 400 rather than silently producing
// an orphaned user on accept. Two confirmed orphans (`abc@chen.me`,
// `a@chen.me`) shipped in two days when super_admin (whose own
// `university_id` is NULL) used the admin UI to invite faculty without
// specifying a university — the create endpoint just stored NULL and the
// accept endpoint propagated NULL onto the new user row, locking them out
// of every per-university feature.
//
// Tests here cover the three create-side cases called out in the issue:
//   1. super_admin invites a faculty user without a university_id → 400
//   2. super_admin invites a faculty user WITH a university_id → 201, row
//      stored with that university_id
//   3. super_admin invites a super_admin without a university_id → 201,
//      row stored with NULL (super_admin is intentionally global)

import { describe, expect, it } from "vitest";

import type {
  CreateInvitationInput,
  Invitation,
  Role,
} from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleCreateInvitation } from "../../src/routes/invitations.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const UNI_ADMIN_ID = "10000000-0000-4000-8000-000000000002";
const UNI_A = "20000000-0000-4000-8000-000000000001";

interface ActorFixture {
  id: string;
  email: string;
  name: string;
  role: Role;
  university_id: string | null;
}

const SUPER_ADMIN: ActorFixture = {
  id: SUPER_ADMIN_ID,
  email: "super@example.com",
  name: "Super",
  role: "super_admin",
  university_id: null,
};

const UNI_ADMIN: ActorFixture = {
  id: UNI_ADMIN_ID,
  email: "admin-a@example.com",
  name: "Admin A",
  role: "university_admin",
  university_id: UNI_A,
};

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    APP_ENV: "development",
    SESSION_SECRET: "test-session-secret",
    // Mailgun secrets intentionally absent — `dispatch()` short-circuits
    // to `mailgun_not_configured`, which is the production state per the
    // UNI-10 deploy comment. The handler still records the
    // email_logs / audit_logs row, which is enough for these tests.
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    SUPPORT_EMAIL: "support@example.com",
  };
}

/** Build a `ProgrammableD1` that satisfies `handleCreateInvitation` reads
 *  for a brand-new invitation: no existing user, no existing pending
 *  invitation, and a refetch that returns the row that was just inserted
 *  (so the 201 response body is well-formed). */
function makeCreateDb(): {
  db: ProgrammableD1;
  insertedInvitation: () => Record<string, unknown> | null;
} {
  const db = new ProgrammableD1();
  let insertedInvitation: Record<string, unknown> | null = null;

  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("insert into invitations ")) {
      // Column order from invitations.ts:
      //   id, email, role, status, token_hash, university_id,
      //   invited_by, expires_at
      // (status is hardcoded to 'pending' inside the SQL string).
      insertedInvitation = {
        id: params[0],
        email: params[1],
        role: params[2],
        token_hash: params[3],
        university_id: params[4],
        invited_by: params[5],
        expires_at: params[6],
      };
    }
  });

  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
      return { ok: 1 };
    }
    if (sql.includes("FROM users") && sql.includes("WHERE email = ?")) {
      // No existing user — create proceeds.
      return null;
    }
    if (
      sql.includes("FROM invitations") &&
      sql.includes("WHERE email = ?") &&
      sql.includes("status = 'pending'")
    ) {
      // No duplicate pending invite.
      return null;
    }
    if (sql.includes("FROM universities")) {
      return { name: "Test University" };
    }
    if (
      sql.includes("FROM invitations") &&
      sql.includes("WHERE id = ?") &&
      insertedInvitation &&
      params[0] === insertedInvitation.id
    ) {
      // Refetch immediately after insert so the response shape is
      // populated. The handler reuses the `mapInvitationStatus` helper
      // which only needs the listed columns.
      return {
        id: insertedInvitation.id,
        email: insertedInvitation.email,
        role: insertedInvitation.role,
        status: "pending",
        token_hash: insertedInvitation.token_hash,
        university_id: insertedInvitation.university_id,
        invited_by: insertedInvitation.invited_by,
        expires_at: insertedInvitation.expires_at,
        accepted_at: null,
        created_at: "2026-05-05T00:00:00.000Z",
      };
    }
    return undefined;
  });

  return { db, insertedInvitation: () => insertedInvitation };
}

function ctxFor(
  actor: ActorFixture,
  db: ProgrammableD1,
  body: CreateInvitationInput,
): RequestContext {
  const url = new URL("https://hub.example.com/api/invitations");
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const auth: AuthState = {
    user: { ...actor, password_hash: "x" } as unknown as UserRow,
    session: {
      id: "s",
      user_id: actor.id,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-05-05T00:00:00.000Z",
      last_activity_at: "2026-05-05T00:00:00.000Z",
    },
  };
  return { request, env: makeEnv(db), url, cookies: {}, auth };
}

describe("POST /api/invitations — UNI-62 university_id contract", () => {
  it("rejects 400 university_required when super_admin invites a faculty user without a university_id", async () => {
    const { db, insertedInvitation } = makeCreateDb();
    const res = await handleCreateInvitation(
      ctxFor(SUPER_ADMIN, db, {
        email: "newfaculty@example.com",
        role: "faculty",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("university_required");

    // Critically: nothing was written. The pre-UNI-62 bug was that this
    // path silently INSERTed an invitation row with `university_id =
    // NULL`, which then propagated onto the user row at accept-time.
    expect(insertedInvitation()).toBeNull();
    expect(db.inserts("invitations").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
    expect(db.inserts("email_logs").length).toBe(0);
  });

  it("creates the invitation when super_admin supplies a target university_id", async () => {
    const { db, insertedInvitation } = makeCreateDb();
    const res = await handleCreateInvitation(
      ctxFor(SUPER_ADMIN, db, {
        email: "newfaculty@example.com",
        role: "faculty",
        university_id: UNI_A,
      }),
    );

    expect(res.status).toBe(201);
    const inserted = insertedInvitation();
    expect(inserted).not.toBeNull();
    expect(inserted!.university_id).toBe(UNI_A);
    expect(inserted!.role).toBe("faculty");
    expect(inserted!.email).toBe("newfaculty@example.com");

    // Response body echoes the persisted row.
    const body = (await res.json()) as {
      data: { invitation: Invitation };
    };
    expect(body.data.invitation.university_id).toBe(UNI_A);
  });

  it("allows a super_admin invitation with no university_id (super_admin is global)", async () => {
    const { db, insertedInvitation } = makeCreateDb();
    const res = await handleCreateInvitation(
      ctxFor(SUPER_ADMIN, db, {
        email: "newadmin@example.com",
        role: "super_admin",
      }),
    );

    expect(res.status).toBe(201);
    const inserted = insertedInvitation();
    expect(inserted).not.toBeNull();
    expect(inserted!.university_id).toBeNull();
    expect(inserted!.role).toBe("super_admin");
  });

  it("auto-fills university_admin's invitation with their own university_id (no orphan path)", async () => {
    // Sanity check that the existing happy path still works after the
    // UNI-62 validation landed: a university_admin who omits
    // `university_id` should get their own university stamped on the
    // row, not a 400.
    const { db, insertedInvitation } = makeCreateDb();
    const res = await handleCreateInvitation(
      ctxFor(UNI_ADMIN, db, {
        email: "newstaff@example.com",
        role: "staff",
      }),
    );

    expect(res.status).toBe(201);
    const inserted = insertedInvitation();
    expect(inserted).not.toBeNull();
    expect(inserted!.university_id).toBe(UNI_A);
  });
});
