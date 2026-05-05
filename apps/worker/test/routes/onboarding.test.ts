// Route tests for the post-MFA onboarding hooks (UNI-57).
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
//          + "callback — successful connect stamps lms_onboarding_dismissed_at"
//   4. Student user (or any non-teaching role) does not see the step at all.
//        → "GET — non-teaching roles get show=false reason=ineligible_role"
//   5. If no provider is enabled at the user's university, step is skipped silently.
//        → "GET — no enabled provider → show=false reason=no_provider_enabled"
//
// Plus origin-routing tests for the OAuth callback so the
// "Connected — sync now or later" step lands on /app/onboarding/lms when
// the user kicked the dance off from the onboarding page, and
// /app/integrations otherwise.

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleDismissOnboardingLmsStep,
  handleGetOnboardingLmsStep,
} from "../../src/routes/onboarding.js";
import {
  handleCanvasOAuthCallback,
  handleStartCanvasConnection,
} from "../../src/routes/lms-connections.js";
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
  client_id: string;
  client_secret_encrypted: string;
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

interface UserRowFixture {
  id: string;
  university_id: string | null;
  lms_onboarding_dismissed_at: string | null;
}

interface StateRow {
  state: string;
  user_id: string;
  university_id: string;
  provider_id: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
  origin: "onboarding" | "integrations";
}

interface SeedOpts {
  providers?: ProviderRow[];
  connections?: ConnectionRow[];
  users?: UserRowFixture[];
  states?: StateRow[];
}

function makeDb(seed: SeedOpts = {}) {
  const db = new ProgrammableD1();
  const providers = (seed.providers ?? []).map((r) => ({ ...r }));
  const connections = (seed.connections ?? []).map((r) => ({ ...r }));
  const users = (seed.users ?? []).map((r) => ({ ...r }));
  const states = (seed.states ?? []).map((r) => ({ ...r }));

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
    if (sql.includes("FROM lms_oauth_states") && sql.includes("WHERE state = ?")) {
      const [s] = params as [string];
      return states.find((r) => r.state === s) ?? null;
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
      //   - callback success: SET lms_onboarding_dismissed_at = COALESCE(...,?), updated_at = ? WHERE id = ?
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
    } else if (sql.startsWith("INSERT INTO lms_oauth_states")) {
      const [
        state,
        user_id,
        university_id,
        provider_id,
        redirect_uri,
        created_at,
        expires_at,
        origin,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        "onboarding" | "integrations",
      ];
      states.push({
        state,
        user_id,
        university_id,
        provider_id,
        redirect_uri,
        created_at,
        expires_at,
        origin,
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
    }
  });

  return { db, providers, connections, users, states };
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

function makeProviderRow(opts: {
  university_id: string;
  enabled: number;
  provider_id?: string;
  base_url?: string;
}): ProviderRow {
  return {
    id: CONFIG_A_ID,
    university_id: opts.university_id,
    provider_id: opts.provider_id ?? "canvas",
    base_url: opts.base_url ?? "https://uni.instructure.com",
    enabled: opts.enabled,
    client_id: "client-id",
    client_secret_encrypted: "ciphertext",
    configured_by_user_id: null,
    configured_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z",
  };
}

function makeUserFixture(
  id: string,
  university_id: string | null,
  dismissed: string | null = null,
): UserRowFixture {
  return {
    id,
    university_id,
    lms_onboarding_dismissed_at: dismissed,
  };
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

  it.each(["faculty", "teacher", "teacher_assistant"] as const)(
    "shows the step for eligible role %s when a provider is enabled and no connection exists",
    async (role) => {
      const { db } = makeDb({
        providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
        users: [makeUserFixture(FACULTY_ID, UNI_A)],
      });
      const res = await handleGetOnboardingLmsStep(
        ctxWith(db, { id: FACULTY_ID, role, university_id: UNI_A }),
      );
      expect(res.status).toBe(200);
      const body = await jsonBody<{
        data: {
          show: boolean;
          reason?: string;
          providers: {
            provider_id: string;
            display_name: string;
            base_url: string;
          }[];
        };
      }>(res);
      expect(body.data.show).toBe(true);
      expect(body.data.reason).toBeUndefined();
      expect(body.data.providers).toEqual([
        {
          provider_id: "canvas",
          display_name: "Canvas",
          base_url: "https://uni.instructure.com",
        },
      ]);
    },
  );

  it.each([
    "student",
    "staff",
    "guest",
    "viewer",
    "super_admin",
    "university_admin",
  ] as const)(
    "skips with reason=ineligible_role for non-teaching role %s",
    async (role) => {
      const { db } = makeDb({
        providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
        users: [makeUserFixture(STUDENT_ID, UNI_A)],
      });
      const res = await handleGetOnboardingLmsStep(
        ctxWith(db, { id: STUDENT_ID, role, university_id: UNI_A }),
      );
      expect(res.status).toBe(200);
      const body = await jsonBody<{
        data: { show: boolean; reason: string; providers: unknown[] };
      }>(res);
      expect(body.data.show).toBe(false);
      expect(body.data.reason).toBe("ineligible_role");
      expect(body.data.providers).toEqual([]);
    },
  );

  it("skips with reason=no_university when the caller has no home tenant", async () => {
    const { db } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
    });
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
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
      users: [
        makeUserFixture(FACULTY_ID, UNI_A, "2026-05-05T01:00:00.000Z"),
      ],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("dismissed");
  });

  it("skips with reason=already_connected when the user has an active LMS connection", async () => {
    const { db } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
      users: [makeUserFixture(FACULTY_ID, UNI_A)],
      connections: [
        {
          id: "c1",
          user_id: FACULTY_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          auth_method: "oauth",
          base_url: "https://uni.instructure.com",
          access_token_encrypted: "ct",
          refresh_token_encrypted: null,
          token_expires_at: null,
          scope: null,
          status: "active",
          last_synced_at: null,
          created_at: "2026-05-05T00:00:00.000Z",
          updated_at: "2026-05-05T00:00:00.000Z",
        },
      ],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("already_connected");
  });

  it("skips silently with reason=no_provider_enabled when the university has no enabled providers", async () => {
    const { db } = makeDb({
      // Provider exists but is disabled — emulates the "configured but
      // toggled off" admin state.
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 0 })],
      users: [makeUserFixture(FACULTY_ID, UNI_A)],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { show: boolean; reason: string };
    }>(res);
    expect(body.data.show).toBe(false);
    expect(body.data.reason).toBe("no_provider_enabled");
  });

  it("does not leak the encrypted client secret in the response shape", async () => {
    const { db } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
      users: [makeUserFixture(FACULTY_ID, UNI_A)],
    });
    const res = await handleGetOnboardingLmsStep(
      ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }),
    );
    const text = await res.clone().text();
    expect(text).not.toContain("client_secret");
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("client_id");
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
    const { db, users } = makeDb({
      users: [makeUserFixture(FACULTY_ID, UNI_A)],
    });
    expect(users[0]?.lms_onboarding_dismissed_at).toBeNull();

    const res = await handleDismissOnboardingLmsStep(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { ok: true; dismissed_at: string };
    }>(res);
    expect(body.data.ok).toBe(true);
    expect(typeof body.data.dismissed_at).toBe("string");
    expect(body.data.dismissed_at.length).toBeGreaterThan(10);

    expect(users[0]?.lms_onboarding_dismissed_at).toBe(body.data.dismissed_at);

    const auditInserts = db.inserts("audit_logs");
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0]?.params[3]).toBe("lms.onboarding.dismissed");
    const metadata = JSON.parse(
      (auditInserts[0]?.params[6] ?? "null") as string,
    );
    expect(metadata.already_dismissed).toBe(false);
    expect(metadata.via).toBe("skip_button");
  });

  it("is idempotent — a second click preserves the original timestamp and audits already_dismissed=true", async () => {
    const original = "2026-05-05T01:00:00.000Z";
    const { db, users } = makeDb({
      users: [makeUserFixture(FACULTY_ID, UNI_A, original)],
    });

    const res = await handleDismissOnboardingLmsStep(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { ok: true; dismissed_at: string };
    }>(res);
    // Echoes the original timestamp; column is unchanged.
    expect(body.data.dismissed_at).toBe(original);
    expect(users[0]?.lms_onboarding_dismissed_at).toBe(original);

    // No UPDATE was executed (the handler skips the write when there's
    // already a non-null value).
    expect(db.updates("users").length).toBe(0);

    // Audit row still written with already_dismissed=true.
    const auditInserts = db.inserts("audit_logs");
    expect(auditInserts.length).toBe(1);
    const metadata = JSON.parse(
      (auditInserts[0]?.params[6] ?? "null") as string,
    );
    expect(metadata.already_dismissed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /api/lms/connections/canvas/start — origin persistence
// ---------------------------------------------------------------------------

describe("POST /api/lms/connections/canvas/start — origin column", () => {
  it("persists origin='onboarding' on the lms_oauth_states row", async () => {
    const { db, states } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
    });
    const res = await handleStartCanvasConnection(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        {
          method: "POST",
          path: "/api/lms/connections/canvas/start",
          body: { origin: "onboarding" },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(states.length).toBe(1);
    expect(states[0]?.origin).toBe("onboarding");
  });

  it("defaults origin to 'integrations' when omitted (back-compat with pre-UNI-57 callers)", async () => {
    const { db, states } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
    });
    const res = await handleStartCanvasConnection(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        {
          method: "POST",
          path: "/api/lms/connections/canvas/start",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(states.length).toBe(1);
    expect(states[0]?.origin).toBe("integrations");
  });

  it("rejects an unknown origin via the schema", async () => {
    const { db } = makeDb({
      providers: [makeProviderRow({ university_id: UNI_A, enabled: 1 })],
    });
    const res = await handleStartCanvasConnection(
      ctxWith(
        db,
        { id: FACULTY_ID, role: "faculty", university_id: UNI_A },
        {
          method: "POST",
          path: "/api/lms/connections/canvas/start",
          body: { origin: "marketing" },
        },
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /api/lms/connections/canvas/callback — origin redirect + dismissed_at stamp
// ---------------------------------------------------------------------------

describe("GET /api/lms/connections/canvas/callback — onboarding origin", () => {
  // Stub the Canvas OAuth token-exchange fetch so the callback can run end
  // to end without reaching the network.
  function stubFetch(): { restore: () => void } {
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "canvas-access-token",
          refresh_token: "canvas-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          user: { id: 99, name: "Canvas User" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    return {
      restore: () => {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      },
    };
  }

  async function buildCallbackFixture(
    origin: "onboarding" | "integrations",
    seedDismissedAt: string | null = null,
  ): Promise<{ db: ProgrammableD1; users: UserRowFixture[] }> {
    const cipher = await encryptForUniversity(ENV, "client-secret-plain", UNI_A);
    const stateValue = "valid-state-token";
    const fixture = makeDb({
      providers: [
        {
          ...makeProviderRow({ university_id: UNI_A, enabled: 1 }),
          client_id: "canvas-client-id",
          client_secret_encrypted: cipher,
        },
      ],
      users: [makeUserFixture(FACULTY_ID, UNI_A, seedDismissedAt)],
      states: [
        {
          state: stateValue,
          user_id: FACULTY_ID,
          university_id: UNI_A,
          provider_id: "canvas",
          redirect_uri:
            "https://hub.example.com/api/lms/connections/canvas/callback",
          created_at: "2026-05-05T00:00:00.000Z",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          origin,
        },
      ],
    });
    return fixture;
  }

  it("redirects to /app/onboarding/lms?connected=canvas when origin=onboarding", async () => {
    const stub = stubFetch();
    try {
      const { db, users } = await buildCallbackFixture("onboarding");
      const res = await handleCanvasOAuthCallback(
        ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }, {
          method: "GET",
          path: "/api/lms/connections/canvas/callback",
          query: "code=xyz&state=valid-state-token",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://hub.example.com/app/onboarding/lms?connected=canvas",
      );
      // Stamping users.lms_onboarding_dismissed_at means the next sign-in
      // skips the onboarding step (acceptance criterion 3).
      expect(users[0]?.lms_onboarding_dismissed_at).not.toBeNull();
    } finally {
      stub.restore();
    }
  });

  it("redirects to /app/integrations?connected=canvas when origin=integrations (default)", async () => {
    const stub = stubFetch();
    try {
      const { db, users } = await buildCallbackFixture("integrations");
      const res = await handleCanvasOAuthCallback(
        ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }, {
          method: "GET",
          path: "/api/lms/connections/canvas/callback",
          query: "code=xyz&state=valid-state-token",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://hub.example.com/app/integrations?connected=canvas",
      );
      // Connecting from /app/integrations also stamps the column so the
      // post-MFA welcome flow doesn't re-prompt on subsequent sign-ins.
      expect(users[0]?.lms_onboarding_dismissed_at).not.toBeNull();
    } finally {
      stub.restore();
    }
  });

  it("preserves the existing lms_onboarding_dismissed_at on a re-connect (COALESCE)", async () => {
    const stub = stubFetch();
    try {
      const original = "2025-12-31T00:00:00.000Z";
      const { db, users } = await buildCallbackFixture("integrations", original);
      const res = await handleCanvasOAuthCallback(
        ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }, {
          method: "GET",
          path: "/api/lms/connections/canvas/callback",
          query: "code=xyz&state=valid-state-token",
        }),
      );
      expect(res.status).toBe(302);
      // Original timestamp survives — COALESCE in the SQL kept the first
      // dismissal time intact.
      expect(users[0]?.lms_onboarding_dismissed_at).toBe(original);
    } finally {
      stub.restore();
    }
  });

  it("includes origin in the lms.connected audit row metadata", async () => {
    const stub = stubFetch();
    try {
      const { db } = await buildCallbackFixture("onboarding");
      const res = await handleCanvasOAuthCallback(
        ctxWith(db, { id: FACULTY_ID, role: "faculty", university_id: UNI_A }, {
          method: "GET",
          path: "/api/lms/connections/canvas/callback",
          query: "code=xyz&state=valid-state-token",
        }),
      );
      expect(res.status).toBe(302);
      const auditInserts = db.inserts("audit_logs");
      const lmsConnected = auditInserts.find(
        (e) => e.params[3] === "lms.connected",
      );
      expect(lmsConnected).toBeDefined();
      const metadata = JSON.parse(
        (lmsConnected?.params[6] ?? "null") as string,
      );
      expect(metadata.origin).toBe("onboarding");
      expect(metadata.provider_id).toBe("canvas");
    } finally {
      stub.restore();
    }
  });
});
