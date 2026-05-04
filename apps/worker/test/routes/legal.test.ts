// Route tests for the privacy-policy + ToS surfaces (UNI-34).
//
// Coverage map back to the issue acceptance criteria:
//
//   - "/privacy and /terms reachable as public routes; render readable
//     content."  → see "GET /api/legal/:kind — public read"
//
//   - "Invitation acceptance is blocked without ToS acknowledgment."
//     → covered by the shared zod schema (the form refuses to submit) and
//        a parser sanity test below.
//
//   - "ToS version bump forces re-acceptance."
//     → see "GET /api/legal/acknowledgment-status — re-acceptance gate"
//
//   - "Customer admin can edit the displayed text via the Legal tab;
//      changes are audit-logged."
//     → see "PATCH /api/legal/admin/:kind — RBAC + audit"

import { describe, expect, it } from "vitest";

import { acceptInvitationInputSchema } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleAcceptLegal,
  handleGetAcknowledgmentStatus,
  handleGetLegalAdmin,
  handleGetLegalDocument,
  handleUpdateLegalDocument,
} from "../../src/routes/legal.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const STUDENT_ID = "00000000-0000-0000-0000-00000000cccc";
const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

interface LegalDocRow {
  id: string;
  university_id: string | null;
  kind: "terms" | "privacy";
  version: number;
  body_md: string;
  published_at: string;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  university_name: string | null;
  updated_by_name: string | null;
}

interface UserAcceptanceRow {
  terms_accepted_at: string | null;
  terms_accepted_version: number | null;
}

function makeDb(opts: {
  legal?: LegalDocRow[];
  users?: Record<string, UserAcceptanceRow>;
  universities?: Record<string, string>;
} = {}): ProgrammableD1 {
  const db = new ProgrammableD1();
  const legal = (opts.legal ?? []).map((r) => ({ ...r }));
  const users = { ...(opts.users ?? {}) };
  const universities = { ...(opts.universities ?? {}) };

  db.onFirst((sql, params) => {
    // PRAGMA foreign_keys
    if (sql.startsWith("PRAGMA")) return null;

    // Looks like a SELECT against legal_documents.
    if (sql.startsWith("SELECT ld.id, ld.university_id, ld.kind")) {
      const isCustomer = sql.includes("ld.university_id = ?") && sql.includes("ld.kind = ?");
      const isGlobal = sql.includes("ld.university_id IS NULL") && sql.includes("ld.kind = ?");
      if (isCustomer) {
        const [universityId, kind] = params as [string, string];
        return legal.find((r) => r.university_id === universityId && r.kind === kind) ?? null;
      }
      if (isGlobal) {
        const [kind] = params as [string];
        return legal.find((r) => r.university_id === null && r.kind === kind) ?? null;
      }
    }

    if (sql.startsWith("SELECT version FROM legal_documents")) {
      if (sql.includes("WHERE university_id = ?")) {
        const [universityId, kind] = params as [string, string];
        return legal.find((r) => r.university_id === universityId && r.kind === kind) ?? null;
      }
      const [kind] = params as [string];
      return legal.find((r) => r.university_id === null && r.kind === kind) ?? null;
    }

    if (sql.startsWith("SELECT terms_accepted_at, terms_accepted_version FROM users")) {
      const [userId] = params as [string];
      return users[userId] ?? { terms_accepted_at: null, terms_accepted_version: null };
    }

    if (sql.startsWith("SELECT name FROM universities WHERE id =")) {
      const [id] = params as [string];
      const name = universities[id];
      return name ? { name } : null;
    }

    if (sql.startsWith("SELECT university_id FROM invitations")) {
      return null;
    }

    return undefined;
  });

  db.onWrite((sql, params) => {
    // Mutate the in-memory legal table on UPDATE / INSERT so the read-after-
    // write `resolveDocument` reflection works in the tests.
    if (sql.startsWith("UPDATE legal_documents")) {
      const [body_md, version, , publishedAt, updated_by_user_id, updated_at, id] =
        params as [string, number, number, string, string, string, string];
      const row = legal.find((r) => r.id === id);
      if (row) {
        row.body_md = body_md;
        if (version > row.version) {
          row.published_at = publishedAt;
          row.version = version;
        }
        row.updated_by_user_id = updated_by_user_id;
        row.updated_at = updated_at;
      }
    }
    if (sql.startsWith("INSERT INTO legal_documents")) {
      const [
        id,
        university_id,
        kind,
        version,
        body_md,
        published_at,
        updated_by_user_id,
        created_at,
        updated_at,
      ] = params as [
        string,
        string | null,
        "terms" | "privacy",
        number,
        string,
        string,
        string | null,
        string,
        string,
      ];
      legal.push({
        id,
        university_id,
        kind,
        version,
        body_md,
        published_at,
        updated_by_user_id,
        created_at,
        updated_at,
        university_name: university_id ? universities[university_id] ?? null : null,
        updated_by_name: null,
      });
    }
    if (sql.startsWith("UPDATE users")) {
      // record-of-acceptance
      if (sql.includes("terms_accepted_at = ?")) {
        const [acceptedAt, acceptedVersion, , userId] = params as [
          string,
          number,
          string,
          string,
        ];
        users[userId] = {
          terms_accepted_at: acceptedAt,
          terms_accepted_version: acceptedVersion,
        };
      }
    }
  });

  return db;
}

const ENV: Env = {
  DB: undefined as unknown as D1Database,
  APP_NAME: "University Hub",
  APP_BASE_URL: "https://hub.example.com",
  SUPPORT_EMAIL: "registrar@example.edu",
} as Env;

function ctxWith(
  db: ProgrammableD1,
  actor: (Partial<UserRow> & Pick<UserRow, "id" | "role">) | null,
  init?: { method?: string; body?: unknown; path?: string },
): RequestContext {
  const url = new URL(`https://hub.example.com${init?.path ?? "/api/legal/terms"}`);
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

const NOW = "2026-05-04T20:00:00.000Z";

function legalRow(
  patch: Partial<LegalDocRow> & Pick<LegalDocRow, "kind">,
): LegalDocRow {
  return {
    id: patch.id ?? `legal-${patch.kind}-${patch.university_id ?? "global"}`,
    university_id: patch.university_id ?? null,
    kind: patch.kind,
    version: patch.version ?? 1,
    body_md: patch.body_md ?? `# ${patch.kind} default v${patch.version ?? 1}`,
    published_at: patch.published_at ?? NOW,
    updated_by_user_id: patch.updated_by_user_id ?? null,
    created_at: patch.created_at ?? NOW,
    updated_at: patch.updated_at ?? NOW,
    university_name: patch.university_name ?? null,
    updated_by_name: patch.updated_by_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

describe("GET /api/legal/:kind — public read", () => {
  it("returns the seeded boilerplate when no row exists for any scope", async () => {
    const db = makeDb();
    const res = await handleGetLegalDocument(ctxWith(db, null), "terms");
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { kind: string; source: string; body_md: string; version: number };
    }>(res);
    expect(body.data.kind).toBe("terms");
    expect(body.data.source).toBe("default");
    expect(body.data.version).toBe(1);
    // Default body must NOT contain raw placeholders — they were templated.
    expect(body.data.body_md).not.toContain("{{contact_email}}");
    expect(body.data.body_md).not.toContain("{{university_name}}");
    expect(body.data.body_md).toContain("registrar@example.edu");
  });

  it("returns the customer override when ?university_id matches", async () => {
    const db = makeDb({
      legal: [
        legalRow({ kind: "terms", university_id: null, version: 3 }),
        legalRow({
          kind: "terms",
          university_id: UNI_A,
          version: 7,
          body_md: "# Custom for Acme U v7",
          university_name: "Acme U",
        }),
      ],
      universities: { [UNI_A]: "Acme U" },
    });
    const res = await handleGetLegalDocument(
      ctxWith(db, null, {
        path: `/api/legal/terms?university_id=${UNI_A}`,
      }),
      "terms",
    );
    const body = await jsonBody<{
      data: {
        source: string;
        version: number;
        body_md: string;
        university_id: string | null;
      };
    }>(res);
    expect(body.data.source).toBe("customer");
    expect(body.data.version).toBe(7);
    expect(body.data.body_md).toContain("Custom for Acme U v7");
    expect(body.data.university_id).toBe(UNI_A);
  });

  it("falls back to the global default when no per-customer row exists", async () => {
    const db = makeDb({
      legal: [
        legalRow({
          kind: "privacy",
          university_id: null,
          version: 4,
          body_md: "# Global default privacy v4",
        }),
      ],
      universities: { [UNI_A]: "Acme U" },
    });
    const res = await handleGetLegalDocument(
      ctxWith(db, null, {
        path: `/api/legal/privacy?university_id=${UNI_A}`,
      }),
      "privacy",
    );
    const body = await jsonBody<{
      data: { source: string; version: number };
    }>(res);
    expect(body.data.source).toBe("default");
    expect(body.data.version).toBe(4);
  });

  it("returns 404 for an unknown kind", async () => {
    const db = makeDb();
    const res = await handleGetLegalDocument(ctxWith(db, null), "spam");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Acknowledgment status — re-acceptance gate
// ---------------------------------------------------------------------------

describe("GET /api/legal/acknowledgment-status — re-acceptance gate", () => {
  it("flags required when the user has never accepted", async () => {
    const db = makeDb({
      legal: [legalRow({ kind: "terms", university_id: UNI_A, version: 1 })],
    });
    const res = await handleGetAcknowledgmentStatus(
      ctxWith(db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    const body = await jsonBody<{
      data: {
        terms_required: boolean;
        current_terms_version: number;
        accepted_terms_version: number | null;
      };
    }>(res);
    expect(body.data.terms_required).toBe(true);
    expect(body.data.current_terms_version).toBe(1);
    expect(body.data.accepted_terms_version).toBeNull();
  });

  it("flags required after a version bump (acceptance < current)", async () => {
    const db = makeDb({
      legal: [legalRow({ kind: "terms", university_id: UNI_A, version: 5 })],
      users: {
        [STUDENT_ID]: {
          terms_accepted_at: "2026-01-01T00:00:00.000Z",
          terms_accepted_version: 3,
        },
      },
    });
    const res = await handleGetAcknowledgmentStatus(
      ctxWith(db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    const body = await jsonBody<{
      data: {
        terms_required: boolean;
        current_terms_version: number;
        accepted_terms_version: number;
      };
    }>(res);
    expect(body.data.terms_required).toBe(true);
    expect(body.data.accepted_terms_version).toBe(3);
    expect(body.data.current_terms_version).toBe(5);
  });

  it("does NOT flag required when accepted_version >= current_version", async () => {
    const db = makeDb({
      legal: [legalRow({ kind: "terms", university_id: UNI_A, version: 5 })],
      users: {
        [STUDENT_ID]: {
          terms_accepted_at: "2026-04-01T00:00:00.000Z",
          terms_accepted_version: 5,
        },
      },
    });
    const res = await handleGetAcknowledgmentStatus(
      ctxWith(db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    const body = await jsonBody<{ data: { terms_required: boolean } }>(res);
    expect(body.data.terms_required).toBe(false);
  });

  it("requires authentication", async () => {
    const db = makeDb();
    const res = await handleGetAcknowledgmentStatus(ctxWith(db, null));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

describe("POST /api/legal/accept", () => {
  it("records terms_accepted_at + version and writes the audit row", async () => {
    const db = makeDb({
      legal: [
        legalRow({ kind: "terms", university_id: UNI_A, version: 4 }),
        legalRow({ kind: "privacy", university_id: UNI_A, version: 2 }),
      ],
    });
    const res = await handleAcceptLegal(
      ctxWith(
        db,
        {
          id: STUDENT_ID,
          role: "student",
          university_id: UNI_A,
        },
        {
          method: "POST",
          path: "/api/legal/accept",
          body: { terms_version: 4, privacy_version: 2 },
        },
      ),
    );
    expect(res.status).toBe(200);

    // users UPDATE was issued.
    const userUpdates = db.updates("users").filter((u) =>
      u.normalizedSql.includes("terms_accepted_at"),
    );
    expect(userUpdates.length).toBe(1);

    // audit_logs INSERT with action legal.terms_accepted.
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("legal.terms_accepted");
  });

  it("rejects with version_mismatch when the echoed version is stale", async () => {
    const db = makeDb({
      legal: [
        legalRow({ kind: "terms", university_id: UNI_A, version: 4 }),
        legalRow({ kind: "privacy", university_id: UNI_A, version: 2 }),
      ],
    });
    const res = await handleAcceptLegal(
      ctxWith(
        db,
        {
          id: STUDENT_ID,
          role: "student",
          university_id: UNI_A,
        },
        {
          method: "POST",
          path: "/api/legal/accept",
          body: { terms_version: 3, privacy_version: 2 },
        },
      ),
    );
    expect(res.status).toBe(409);
    const body = await jsonBody<{ ok: false; error: { code: string } }>(res);
    expect(body.error.code).toBe("version_mismatch");
    // No update / audit when we refuse.
    expect(db.updates("users").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Admin GET / PATCH
// ---------------------------------------------------------------------------

describe("GET /api/legal/admin", () => {
  it("rejects students (403)", async () => {
    const db = makeDb();
    const res = await handleGetLegalAdmin(
      ctxWith(db, {
        id: STUDENT_ID,
        role: "student",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a university_admin reading another uni (403)", async () => {
    const db = makeDb();
    const res = await handleGetLegalAdmin(
      ctxWith(
        db,
        {
          id: UNI_ADMIN_ID,
          role: "university_admin",
          university_id: UNI_A,
        },
        {
          path: `/api/legal/admin?university_id=${UNI_B}`,
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("returns both kinds with body for the actor's university", async () => {
    const db = makeDb({
      legal: [
        legalRow({ kind: "terms", university_id: UNI_A, version: 2 }),
      ],
      universities: { [UNI_A]: "Acme U" },
    });
    const res = await handleGetLegalAdmin(
      ctxWith(db, {
        id: UNI_ADMIN_ID,
        role: "university_admin",
        university_id: UNI_A,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: {
        university_id: string | null;
        documents: {
          terms: { is_overridden: boolean; version: number };
          privacy: { is_overridden: boolean; version: number };
        };
      };
    }>(res);
    expect(body.data.university_id).toBe(UNI_A);
    expect(body.data.documents.terms.is_overridden).toBe(true);
    expect(body.data.documents.terms.version).toBe(2);
    expect(body.data.documents.privacy.is_overridden).toBe(false);
    expect(body.data.documents.privacy.version).toBe(1);
  });
});

describe("PATCH /api/legal/admin/:kind — RBAC + audit", () => {
  it("rejects non-admin (403)", async () => {
    const db = makeDb();
    const res = await handleUpdateLegalDocument(
      ctxWith(
        db,
        {
          id: STUDENT_ID,
          role: "student",
          university_id: UNI_A,
        },
        {
          method: "PATCH",
          path: "/api/legal/admin/terms",
          body: { body_md: "# Hi", version_bump: false },
        },
      ),
      "terms",
    );
    expect(res.status).toBe(403);
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("INSERTs a new override and writes the audit row when none exists yet", async () => {
    const db = makeDb({ universities: { [UNI_A]: "Acme U" } });
    const res = await handleUpdateLegalDocument(
      ctxWith(
        db,
        {
          id: UNI_ADMIN_ID,
          role: "university_admin",
          university_id: UNI_A,
        },
        {
          method: "PATCH",
          path: "/api/legal/admin/terms",
          body: { body_md: "# Custom Acme terms", version_bump: false },
        },
      ),
      "terms",
    );
    expect(res.status).toBe(200);
    expect(db.inserts("legal_documents").length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("legal.document_updated");
  });

  it("UPDATEs in place + bumps the version when version_bump=true", async () => {
    const db = makeDb({
      legal: [
        legalRow({
          id: "legal-terms-A",
          kind: "terms",
          university_id: UNI_A,
          version: 1,
          body_md: "# Old",
        }),
      ],
      universities: { [UNI_A]: "Acme U" },
    });
    const res = await handleUpdateLegalDocument(
      ctxWith(
        db,
        {
          id: UNI_ADMIN_ID,
          role: "university_admin",
          university_id: UNI_A,
        },
        {
          method: "PATCH",
          path: "/api/legal/admin/terms",
          body: { body_md: "# New", version_bump: true },
        },
      ),
      "terms",
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { version: number; body_md: string };
    }>(res);
    expect(body.data.version).toBe(2);
    expect(body.data.body_md).toBe("# New");

    const updates = db.updates("legal_documents");
    expect(updates.length).toBe(1);
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    // metadata JSON includes version_bumped: true
    const metadata = audits[0]!.params[6] as string;
    expect(metadata).toContain('"version_bumped":true');
  });

  it("rejects super_admin-only edits to the global default from a university_admin", async () => {
    const db = makeDb();
    const res = await handleUpdateLegalDocument(
      ctxWith(
        db,
        {
          id: SUPER_ADMIN_ID,
          role: "super_admin",
        },
        {
          method: "PATCH",
          path: "/api/legal/admin/terms",
          body: { body_md: "# Global", version_bump: false },
        },
      ),
      "terms",
    );
    // super_admin without university_id and no ?university_id= edits the
    // GLOBAL default — should succeed.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Schema-level acceptance criterion: the invitation accept payload requires
// terms_accepted=true (UNI-34 spec).
// ---------------------------------------------------------------------------

describe("acceptInvitationInputSchema — terms_accepted is required", () => {
  it("refuses payloads without terms_accepted=true", () => {
    const result = acceptInvitationInputSchema.safeParse({
      token: "x".repeat(40),
      email: "user@example.com",
      name: "User",
      password: "password1",
      confirmPassword: "password1",
      // terms_accepted intentionally omitted
    });
    expect(result.success).toBe(false);
  });
  it("refuses terms_accepted=false", () => {
    const result = acceptInvitationInputSchema.safeParse({
      token: "x".repeat(40),
      email: "user@example.com",
      name: "User",
      password: "password1",
      confirmPassword: "password1",
      terms_accepted: false,
    });
    expect(result.success).toBe(false);
  });
  it("accepts terms_accepted=true", () => {
    const result = acceptInvitationInputSchema.safeParse({
      token: "x".repeat(40),
      email: "user@example.com",
      name: "User",
      password: "password1",
      confirmPassword: "password1",
      terms_accepted: true,
    });
    expect(result.success).toBe(true);
  });
});
