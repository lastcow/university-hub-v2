// Route tests for the post-MFA onboarding hooks (UNI-57; reshaped in
// UNI-63 to drop the OAuth callback round-trip — the connect handler
// now stamps `users.lms_onboarding_dismissed_at` directly when the
// PAT save succeeds).
//
// Coverage map back to the issue acceptance criteria:
//
//   1. Faculty user without an LMS connection sees the step on first
//      post-MFA sign-in.
//        → "GET — eligible faculty/teacher/teacher_assistant gets show=true"
//   2. Faculty user who skipped does NOT see it again.
//        → "GET — dismissed-at stamped → show=false reason=dismissed"
//          + "POST dismiss — stamps users.lms_onboarding_dismissed_at"
//   3. Faculty user who connected does NOT see it again.
//        → "GET — active connection → show=false reason=already_connected"
//          + "POST /canvas — successful connect stamps lms_onboarding_dismissed_at"
//   4. Student user (or any non-teaching role) does not see the step at all.
//        → "GET — non-teaching roles get show=false reason=ineligible_role"
//   5. If no provider is enabled at the user's university, step is skipped silently.
//        → "GET — no enabled provider → show=false reason=no_provider_enabled"

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleDismissOnboardingLmsStep,
  handleGetOnboardingLmsStep,
} from "../../src/routes/onboarding.js";
import { handleConnectCanvasConnection } from "../../src/routes/lms-connections.js";
import { encryptForUniversity } from "../../src/crypto/field-encryption.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const FACULTY_ID = "22222222-2222-2222-2222-222222222222";
const STUDENT_ID = "33333333-3333-3333-3333-333333333333";
const ADMIN_ID = "44444444-4444-4444-4444-444444444444";
const CONFIG_A_ID = "55555555-5555-5555-5555-555555555555";

const ENV: Env = {
  DB: undefined as unknown as D1Database,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  LMS_TOKEN_ENCRYPTION_KEY:
    "test-master-key-do-not-use-in-prod-aaaaaaaaaaaaaaaaaaaaaaaaaa",
} as Env;

interface ProviderRow {
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

interface UserRowFixture {
  id: string;
  university_id: string | null;
  lms_onboarding_dismissed_at: string | null;
}

interface SeedOpts {
  providers?: ProviderRow[];
  connections?: ConnectionRow[];
  users?: UserRowFixture[];
}

function makeDb(seed: SeedOpts = {}) {
  const db = new ProgrammableD1();
  const providers = (seed.providers ?? []).map((r) => ({ ...r }));
  const connections = (seed.connections ?? []).map((r) => ({ ...r }));
  const users = (seed.users ?? []).map((r) => ({ ...r }));

  db.onFirst((sql, params) => {
    if (sql.startsWith("PRAGMA")) return null;
    if (
      sql.includes("FROM lms_provider_configs") &&
      sql.includes("WHERE university_id = ? AND provider_id = ?")
    ) {
      const [uni, provider] = params as [string, string];
      return (
        providers.find(
          (r) => r.university_id === uni && r.provider_id === provider,
        ) ?? null
      );
    }
    if (
      sql.includes("FROM lms_connections") &&
      sql.includes("WHERE user_id = ? AND status = 'active'")
    ) {
      const [user] = params as [string];
      return (
        connections.find(
          (r) => r.user_id === user && r.status === "active",
        ) ?? null
      );
    }
    if (
      sql.includes("SELECT lms_onboarding_dismissed_at FROM users") &&
      sql.includes("WHERE id = ?")
    ) {
      const [id] = params as [string];
      const u = users.find((r) => r.id === id);
      return u
        ? { lms_onboarding_dismissed_at: u.lms_onboarding_dismissed_at }
        : null;
    }
    if (
      sql.includes("FROM lms_connections") &&
      sql.includes("WHERE id = ?")
    ) {
      const [id] = params as [string];
      return connections.find((r) => r.id === id) ?? null;
    }
    if (
      sql.includes("FROM lms_connections") &&
      sql.includes("WHERE user_id = ? AND provider_id = ?")
    ) {
      const [user, provider] = params as [string, string];
      return (
        connections.find(
          (r) => r.user_id === user && r.provider_id === provider,
        ) ?? null
      );
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    if (
      sql.includes("FROM lms_provider_configs") &&
      sql.includes("WHERE university_id = ? AND enabled = 1")
    ) {
      const [uni] = params as [string];
      return providers
        .filter((r) => r.university_id === uni && r.enabled === 1)
        .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
    }
    return undefined;
  });

  db.onWrite((sql, params) => {
    if (sql.startsWith("UPDATE users") && sql.includes("lms_onboarding_dismissed_at")) {
      // Two distinct shapes hit this branch:
      //   - dismiss handler: SET lms_onboarding_dismissed_at = ?, updated_at = ? WHERE id = ?
      //   - connect success: SET lms_onboarding_dismissed_at = COALESCE(...,?), updated_at = ? WHERE id = ?
      // Both are 3-arg; the COALESCE form preserves the existing value if any.
      const [dismissedAt, _updatedAt, id] = params as [string, string, string];
      const u = users.find((r) => r.id === id);
      if (!u) return;
      if (sql.includes("COALESCE")) {
        u.lms_onboarding_dismissed_at =
          u.lms_onboarding_dismissed_at ?? dismissedAt;
      } else {
        u.lms_onboarding_dismissed_at = dismissedAt;
      }
    } else if (sql.startsWith("INSERT INTO lms_connections")) {
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
    } else if (sql.startsWith("UPDATE lms_connections") && sql.includes("SET university_id = ?")) {
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
  });

  return { db, providers, connections, users };
}

function ctxWith(
  db: ProgrammableD1,
  actor: (Partial<UserRow> & Pick<UserRow, "id" | "role">) | null,
  init?: { method?: string; body?: unknown; path?: string; query?: string },
): RequestContext {
  const path = init?.path ?? "/api/onboarding/lms-step";
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

function seedProviderRow(): ProviderRow {
  return {
    id: CONFIG_A_ID,
    university_id: UNI_A,
    provider_id: "canvas",
    base_url: "https://canvas.example.edu",
    enabled: 1,
    configured_by_user_id: ADMIN_ID,
    configured_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

function seedUserRow(
  id: string,
  dismissedAt: string | null = null,
): UserRowFixture {
  return { id, university_id: UNI_A, lms_onboarding_dismissed_at: dismissedAt };
}

// ---------------------------------------------------------------------------
// GET /api/onboarding/lms-step
// ---------------------------------------------------------------------------

describe("GET /api/onboarding/lms-step", () => {
  it("returns 401 when unauthenticated", async () => {
    const { db } = makeDb();
    const res = await handleGetOnboardingLmsStep(ctxWith(db, null));
    expect(res.status).toBe(401);
  });

  it("returns show=true with the enabled providers for an eligible faculty user", async () => {
    const { db } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(FACULTY_ID)],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; providers: Array<{ provider_id: string }> };
    }>(res);
    expect(body.data.show).toBe(true);
    expect(body.data.providers).toHaveLength(1);
    expect(body.data.providers[0]!.provider_id).toBe("canvas");
  });

  it("treats teacher and teacher_assistant the same as faculty", async () => {
    for (const role of ["teacher", "teacher_assistant"] as const) {
      const { db } = makeDb({
        providers: [seedProviderRow()],
        users: [seedUserRow(FACULTY_ID)],
      });
      const res = await handleGetOnboardingLmsStep(
        ctxWith(db, { id: FACULTY_ID, role, university_id: UNI_A }),
      );
      expect(res.status, `role=${role}`).toBe(200);
      const body = await jsonBody<{ data: { show: boolean } }>(res);
      expect(body.data.show, `role=${role}`).toBe(true);
    }
  });

  it("skips with reason=ineligible_role for non-teaching roles", async () => {
    const { db } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(STUDENT_ID)],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: STUDENT_ID, role: "student", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("ineligible_role");
  });

  it("skips with reason=no_university when the caller has no home tenant", async () => {
    const { db } = makeDb();
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: null }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("no_university");
  });

  it("skips with reason=dismissed once users.lms_onboarding_dismissed_at is set", async () => {
    const { db } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(FACULTY_ID, "2026-05-04T18:00:00.000Z")],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("dismissed");
  });

  it("skips with reason=already_connected when the user has an active LMS connection", async () => {
    const accessCt = await encryptForUniversity(ENV, "live-pat", UNI_A);
    const { db } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(FACULTY_ID)],
      connections: [
        {
          id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          user_id: FACULTY_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          base_url: "https://canvas.example.edu",
          access_token_encrypted: accessCt,
          status: "active",
          last_synced_at: null,
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("already_connected");
  });

  it("skips silently with reason=no_provider_enabled when the university has no enabled providers", async () => {
    const { db } = makeDb({
      providers: [{ ...seedProviderRow(), enabled: 0 }],
      users: [seedUserRow(FACULTY_ID)],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("no_provider_enabled");
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboarding/lms-step/dismiss
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/lms-step/dismiss", () => {
  it("returns 401 when unauthenticated", async () => {
    const { db } = makeDb();
    const res = await handleDismissOnboardingLmsStep(
      ctxWith(db, null, { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("stamps users.lms_onboarding_dismissed_at and writes a single audit row on first call", async () => {
    const { db, users } = makeDb({ users: [seedUserRow(FACULTY_ID)] });
    const res = await handleDismissOnboardingLmsStep(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { ok: true; dismissed_at: string } }>(res);
    expect(body.data.ok).toBe(true);
    expect(body.data.dismissed_at).toBeTruthy();
    expect(users[0]!.lms_onboarding_dismissed_at).toBe(body.data.dismissed_at);
    expect(db.inserts("audit_logs").length).toBe(1);
  });

  it("is idempotent — a second click preserves the original timestamp", async () => {
    const original = "2026-05-04T18:00:00.000Z";
    const { db, users } = makeDb({
      users: [seedUserRow(FACULTY_ID, original)],
    });
    const res = await handleDismissOnboardingLmsStep(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(200);
    expect(users[0]!.lms_onboarding_dismissed_at).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// POST /api/lms/connections/canvas — onboarding integration
//
// UNI-63 collapses the OAuth callback's "stamp dismissed_at on success"
// behavior into the PAT connect handler. A faculty user who pastes a
// PAT (whether from /app/onboarding/lms or /app/integrations) should
// have `lms_onboarding_dismissed_at` set so a refresh won't re-route
// them to the onboarding step.
// ---------------------------------------------------------------------------

describe("POST /api/lms/connections/canvas — onboarding hand-off", () => {
  it("stamps users.lms_onboarding_dismissed_at on a successful connect", async () => {
    const { db, users } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(FACULTY_ID)],
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
          { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
          {
            method: "POST",
            body: { personal_access_token: "the-real-canvas-pat" },
          },
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(users[0]!.lms_onboarding_dismissed_at).toBeTruthy();
  });

  it("preserves an earlier dismiss timestamp on a re-connect (COALESCE)", async () => {
    const original = "2026-04-30T12:00:00.000Z";
    const { db, users } = makeDb({
      providers: [seedProviderRow()],
      users: [seedUserRow(FACULTY_ID, original)],
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
          { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
          {
            method: "POST",
            body: { personal_access_token: "fresh-pat" },
          },
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(users[0]!.lms_onboarding_dismissed_at).toBe(original);
  });
});
