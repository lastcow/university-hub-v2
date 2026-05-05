// Route tests for FERPA controls (UNI-32):
//   - directory-info opt-out PATCH
//   - disclosure consents (create + list + revoke)
//   - disclosure log (record requires non-revoked consent)
//   - parent sign-in (request + verify + me + grades)
//
// Uses the same `ProgrammableD1` fake as the grades tests; we pre-program
// resolvers per query string and let the route handlers run end-to-end.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import type { UserRow } from "../../src/auth/session.js";
import {
  PARENT_SESSION_COOKIE,
  hashToken,
} from "../../src/auth/parent-session.js";
import {
  handleCreateDisclosureConsent,
  handleListDisclosureConsents,
  handleRevokeDisclosureConsent,
} from "../../src/routes/disclosure-consents.js";
import {
  handleListDisclosures,
  handleRecordDisclosure,
} from "../../src/routes/disclosures.js";
import {
  handleParentGrades,
  handleParentMe,
  handleParentSignInRequest,
  handleParentSignInVerify,
  handleParentSignOut,
} from "../../src/routes/parent-auth.js";
import { handleUpdateStudentDirectoryInfo } from "../../src/routes/students.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const SUPER_ADMIN_ID = "55555555-0000-0000-0000-000000000001";
const UNI_A_ADMIN_ID = "55555555-0000-0000-0000-000000000002";
const UNI_A_STAFF_ID = "55555555-0000-0000-0000-000000000003";
const UNI_A_FACULTY_ID = "55555555-0000-0000-0000-000000000010";
const STUDENT_OVER18_ID = "55555555-0000-0000-0000-000000000040";
const STUDENT_UNDER18_ID = "55555555-0000-0000-0000-000000000041";
const STUDENT_OTHER_UNI_ID = "55555555-0000-0000-0000-000000000042";

const STUDENT_OVER18_ROW_ID = "66666666-aaaa-0000-0000-000000000001";
const STUDENT_UNDER18_ROW_ID = "66666666-aaaa-0000-0000-000000000002";
const STUDENT_OTHER_UNI_ROW_ID = "66666666-aaaa-0000-0000-000000000003";

const TS = "2026-05-04T00:00:00.000Z";
const PARENT_EMAIL = "guardian@example.com";

interface User extends UserRow {}

function user(
  id: string,
  role: User["role"],
  university_id: string | null,
): User {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    status: "active",
    university_id,
    password_hash: "x",
    last_sign_in_at: null,
    created_at: TS,
    updated_at: TS,
  };
}

const ACTORS = {
  superAdmin: user(SUPER_ADMIN_ID, "super_admin", null),
  uniAAdmin: user(UNI_A_ADMIN_ID, "university_admin", UNI_A),
  uniAStaff: user(UNI_A_STAFF_ID, "staff", UNI_A),
  uniAFaculty: user(UNI_A_FACULTY_ID, "faculty", UNI_A),
  studentOver18: user(STUDENT_OVER18_ID, "student", UNI_A),
  studentUnder18: user(STUDENT_UNDER18_ID, "student", UNI_A),
  studentOtherUni: user(STUDENT_OTHER_UNI_ID, "student", UNI_B),
};

interface SeededStudent {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  student_number: string | null;
  directory_info_opt_out: number;
  under_18: number;
  parent_guardian_email: string | null;
  created_at: string;
  updated_at: string;
}

interface SeededConsent {
  id: string;
  student_user_id: string;
  university_id: string | null;
  requester: string;
  purpose: string;
  data_categories: string;
  granted_at: string;
  granted_by_user_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SeededLog {
  id: string;
  student_user_id: string;
  university_id: string | null;
  consent_id: string | null;
  basis:
    | "consent"
    | "school_official_exception"
    | "directory_info"
    | "judicial_order"
    | "other";
  released_to: string;
  data_categories: string;
  notes: string | null;
  released_at: string;
  released_by_user_id: string | null;
}

interface Fixture {
  db: ProgrammableD1;
  students: Map<string, SeededStudent>;
  consents: Map<string, SeededConsent>;
  logs: Map<string, SeededLog>;
  parentTokens: Map<string, {
    id: string;
    student_user_id: string;
    parent_email: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    created_at: string;
  }>;
  parentSessions: Map<string, {
    id: string;
    student_user_id: string;
    parent_email: string;
    token_hash: string;
    expires_at: string;
    created_at: string;
    last_activity_at: string;
  }>;
}

function seedFixture(): Fixture {
  const db = new ProgrammableD1();
  const users = new Map<string, User>(
    Object.values(ACTORS).map((a) => [a.id, a]),
  );

  const students = new Map<string, SeededStudent>([
    [
      STUDENT_OVER18_ROW_ID,
      {
        id: STUDENT_OVER18_ROW_ID,
        user_id: STUDENT_OVER18_ID,
        university_id: UNI_A,
        department_id: null,
        student_number: "S-001",
        directory_info_opt_out: 0,
        under_18: 0,
        parent_guardian_email: null,
        created_at: TS,
        updated_at: TS,
      },
    ],
    [
      STUDENT_UNDER18_ROW_ID,
      {
        id: STUDENT_UNDER18_ROW_ID,
        user_id: STUDENT_UNDER18_ID,
        university_id: UNI_A,
        department_id: null,
        student_number: "S-002",
        directory_info_opt_out: 0,
        under_18: 1,
        parent_guardian_email: PARENT_EMAIL,
        created_at: TS,
        updated_at: TS,
      },
    ],
    [
      STUDENT_OTHER_UNI_ROW_ID,
      {
        id: STUDENT_OTHER_UNI_ROW_ID,
        user_id: STUDENT_OTHER_UNI_ID,
        university_id: UNI_B,
        department_id: null,
        student_number: "S-100",
        directory_info_opt_out: 0,
        under_18: 0,
        parent_guardian_email: null,
        created_at: TS,
        updated_at: TS,
      },
    ],
  ]);

  const consents = new Map<string, SeededConsent>();
  const logs = new Map<string, SeededLog>();
  const parentTokens = new Map<string, Fixture["parentTokens"] extends Map<string, infer V> ? V : never>();
  const parentSessions = new Map<string, Fixture["parentSessions"] extends Map<string, infer V> ? V : never>();

  // ---- first()-resolvers --------------------------------------------------
  db.onFirst((sql, params) => {
    const s = sql.toLowerCase();

    // Student SELECT_LIST by id
    if (
      s.startsWith("select s.id, s.user_id, s.university_id") &&
      s.includes("where s.id = ?")
    ) {
      const row = students.get(String(params[0]));
      if (!row) return null;
      return {
        ...row,
        name: users.get(row.user_id)?.name ?? "",
        email: users.get(row.user_id)?.email ?? "",
        university_name: row.university_id === UNI_A ? "Uni A" : "Uni B",
        department_name: null,
      };
    }

    // disclosure-consents loadStudentByUserId
    if (
      s.startsWith("select u.id as id, u.role as role, u.university_id as university_id,") &&
      s.includes("where u.id = ?")
    ) {
      const u = users.get(String(params[0]));
      if (!u) return null;
      const studentRow = Array.from(students.values()).find(
        (sr) => sr.user_id === u.id,
      );
      return {
        id: u.id,
        role: u.role,
        university_id: u.university_id,
        under_18: studentRow ? studentRow.under_18 : null,
      };
    }

    // disclosure_consents SELECT_BASE by id
    if (
      s.startsWith("select dc.id, dc.student_user_id, dc.university_id,") &&
      s.includes("where dc.id = ?")
    ) {
      const c = consents.get(String(params[0]));
      if (!c) return null;
      return enrichConsent(c, users, students);
    }

    // SELECT consent for record-disclosure validation
    if (
      s.startsWith("select id, student_user_id, university_id, data_categories, expires_at, revoked_at")
    ) {
      const c = consents.get(String(params[0]));
      if (!c) return null;
      return {
        id: c.id,
        student_user_id: c.student_user_id,
        university_id: c.university_id,
        data_categories: c.data_categories,
        expires_at: c.expires_at,
        revoked_at: c.revoked_at,
      };
    }

    // disclosure_log SELECT by id (after insert).
    if (
      s.startsWith("select dl.id, dl.student_user_id, dl.university_id, dl.consent_id,") &&
      s.includes("where dl.id = ?")
    ) {
      const log = logs.get(String(params[0]));
      if (!log) return null;
      const su = users.get(log.student_user_id);
      const consent = consents.get(log.consent_id);
      const releaser = log.released_by_user_id
        ? users.get(log.released_by_user_id)
        : null;
      return {
        ...log,
        student_name: su?.name ?? null,
        student_email: su?.email ?? null,
        student_university_id: su?.university_id ?? null,
        released_by_name: releaser?.name ?? null,
        consent_requester: consent?.requester ?? null,
        consent_purpose: consent?.purpose ?? null,
      };
    }

    // disclosure_log COUNT row for the list endpoint
    if (s.startsWith("select count(1) as c from disclosure_log")) {
      return { c: 0 };
    }

    // rate-limit counters SELECT — always under-limit for these tests.
    if (s.startsWith("select count, expires_at from rate_limit_counters")) {
      return null;
    }

    return undefined;
  });

  // ---- all()-resolvers ----------------------------------------------------
  db.onAll((sql, params) => {
    const s = sql.toLowerCase();

    // disclosure_consents list
    if (
      s.startsWith("select dc.id, dc.student_user_id, dc.university_id,") &&
      s.includes("from disclosure_consents")
    ) {
      const studentFilter = params.find(
        (p) => typeof p === "string" && /^[0-9a-f-]{8,}/.test(p),
      );
      let out = Array.from(consents.values());
      if (typeof studentFilter === "string") {
        out = out.filter((c) => c.student_user_id === studentFilter);
      }
      return out
        .map((c) => enrichConsent(c, users, students))
        .sort((a, b) => (a.granted_at < b.granted_at ? 1 : -1));
    }

    // disclosure_log list
    if (
      s.startsWith("select dl.id, dl.student_user_id, dl.university_id, dl.consent_id,") &&
      s.includes("from disclosure_log")
    ) {
      return [];
    }

    // students by parent email
    if (
      s.startsWith("select s.id as student_id, s.user_id as user_id") &&
      s.includes("where s.parent_guardian_email = ? and s.under_18 = 1")
    ) {
      const email = String(params[0]);
      return Array.from(students.values())
        .filter(
          (sr) =>
            sr.parent_guardian_email === email && Number(sr.under_18) === 1,
        )
        .map((sr) => ({
          student_id: sr.id,
          user_id: sr.user_id,
          university_id: sr.university_id,
          parent_guardian_email: sr.parent_guardian_email,
          under_18: sr.under_18,
          name: users.get(sr.user_id)?.name ?? "",
          email: users.get(sr.user_id)?.email ?? "",
          university_name: sr.university_id === UNI_A ? "Uni A" : "Uni B",
        }));
    }

    // student summary by user id (parent flow)
    if (
      s.startsWith("select s.id as student_id, s.user_id as user_id") &&
      s.includes("where s.user_id = ?")
    ) {
      const userId = String(params[0]);
      const sr = Array.from(students.values()).find((r) => r.user_id === userId);
      if (!sr) return [];
      return [
        {
          student_id: sr.id,
          user_id: sr.user_id,
          university_id: sr.university_id,
          parent_guardian_email: sr.parent_guardian_email,
          under_18: sr.under_18,
          name: users.get(sr.user_id)?.name ?? "",
          email: users.get(sr.user_id)?.email ?? "",
          university_name: sr.university_id === UNI_A ? "Uni A" : "Uni B",
        },
      ];
    }

    // parent grades query — return [] (no grades seeded) so the response is
    // [] but the access-log assertions still pass when we want them to be 0.
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("where g.student_user_id = ?")
    ) {
      return [];
    }

    return undefined;
  });

  // ---- writes mirrored back into in-memory maps ---------------------------
  db.onWrite((sql, params) => {
    const s = sql.toLowerCase();

    if (s.startsWith("insert into disclosure_consents")) {
      const [
        id,
        student_user_id,
        university_id,
        requester,
        purpose,
        data_categories,
        granted_at,
        granted_by_user_id,
        expires_at,
        created_at,
        updated_at,
      ] = params as readonly (string | null)[];
      consents.set(String(id), {
        id: String(id),
        student_user_id: String(student_user_id),
        university_id: university_id as string | null,
        requester: String(requester),
        purpose: String(purpose),
        data_categories: String(data_categories),
        granted_at: String(granted_at),
        granted_by_user_id: granted_by_user_id as string | null,
        expires_at: expires_at as string | null,
        revoked_at: null,
        revoked_by_user_id: null,
        created_at: String(created_at),
        updated_at: String(updated_at),
      });
    }

    if (
      s.startsWith("update disclosure_consents") &&
      s.includes("set revoked_at")
    ) {
      const [revoked_at, revoked_by_user_id, updated_at, id] =
        params as readonly (string | null)[];
      const c = consents.get(String(id));
      if (c) {
        c.revoked_at = String(revoked_at);
        c.revoked_by_user_id = revoked_by_user_id as string | null;
        c.updated_at = String(updated_at);
      }
    }

    if (s.startsWith("insert into disclosure_log")) {
      const [
        id,
        student_user_id,
        university_id,
        consent_id,
        released_to,
        data_categories,
        notes,
        released_at,
        released_by_user_id,
      ] = params as readonly (string | null)[];
      logs.set(String(id), {
        id: String(id),
        student_user_id: String(student_user_id),
        university_id: university_id as string | null,
        consent_id: String(consent_id),
        basis: "consent",
        released_to: String(released_to),
        data_categories: String(data_categories),
        notes: notes as string | null,
        released_at: String(released_at),
        released_by_user_id: released_by_user_id as string | null,
      });
    }

    if (s.startsWith("update students set directory_info_opt_out")) {
      const [next, updated_at, id] = params as readonly (string | null | number)[];
      const sr = students.get(String(id));
      if (sr) {
        sr.directory_info_opt_out = Number(next);
        sr.updated_at = String(updated_at);
      }
    }

    // Parent token + session writes
    if (s.startsWith("insert into parent_sign_in_tokens")) {
      const [id, student_user_id, parent_email, token_hash, expires_at, created_at] =
        params as readonly string[];
      parentTokens.set(token_hash, {
        id,
        student_user_id,
        parent_email,
        token_hash,
        expires_at,
        used_at: null,
        created_at,
      });
    }
    if (s.startsWith("delete from parent_sign_in_tokens where id = ?")) {
      const [id] = params as readonly string[];
      for (const [hash, row] of parentTokens) {
        if (row.id === id) {
          parentTokens.delete(hash);
          break;
        }
      }
    }
    if (s.startsWith("insert into parent_sessions")) {
      const [
        id,
        student_user_id,
        parent_email,
        token_hash,
        expires_at,
        created_at,
        last_activity_at,
      ] = params as readonly string[];
      parentSessions.set(token_hash, {
        id,
        student_user_id,
        parent_email,
        token_hash,
        expires_at,
        created_at,
        last_activity_at,
      });
    }
    if (s.startsWith("delete from parent_sessions where token_hash = ?")) {
      const [hash] = params as readonly string[];
      parentSessions.delete(hash);
    }
    if (s.startsWith("delete from parent_sessions where id = ?")) {
      const [id] = params as readonly string[];
      for (const [hash, row] of parentSessions) {
        if (row.id === id) {
          parentSessions.delete(hash);
          break;
        }
      }
    }
    if (s.startsWith("update parent_sessions set last_activity_at")) {
      const [last_activity_at, id] = params as readonly string[];
      for (const row of parentSessions.values()) {
        if (row.id === id) row.last_activity_at = last_activity_at;
      }
    }
  });

  // Resolve parent_sign_in_tokens by token hash + parent_email
  db.onFirst((sql, params) => {
    const s = sql.toLowerCase();
    if (
      s.startsWith(
        "select id, student_user_id, parent_email, token_hash, expires_at, used_at, created_at from parent_sign_in_tokens",
      )
    ) {
      const [hash, email] = params as readonly string[];
      const row = parentTokens.get(hash);
      if (!row || row.parent_email !== email) return null;
      return row;
    }
    if (
      s.startsWith(
        "select id, student_user_id, parent_email, token_hash, expires_at, created_at, last_activity_at from parent_sessions where token_hash = ?",
      )
    ) {
      const [hash] = params as readonly string[];
      return parentSessions.get(hash) ?? null;
    }
    return undefined;
  });

  return { db, students, consents, logs, parentTokens, parentSessions };
}

function enrichConsent(
  c: SeededConsent,
  users: Map<string, User>,
  students: Map<string, SeededStudent>,
) {
  const studentUser = users.get(c.student_user_id);
  const studentRow = Array.from(students.values()).find(
    (sr) => sr.user_id === c.student_user_id,
  );
  const grantedBy = c.granted_by_user_id
    ? users.get(c.granted_by_user_id)
    : null;
  return {
    ...c,
    student_name: studentUser?.name ?? null,
    student_email: studentUser?.email ?? null,
    student_university_id: studentRow?.university_id ?? null,
    granted_by_name: grantedBy?.name ?? null,
  };
}

function makeCtx(
  actor: UserRow | null,
  db: ProgrammableD1,
  init: {
    method?: string;
    pathname?: string;
    body?: unknown;
    cookies?: Record<string, string>;
  } = {},
): RequestContext {
  const url = new URL(`https://hub.example.com${init.pathname ?? "/api/test"}`);
  const env: Env = {
    DB: db as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    SESSION_COOKIE_NAME: "university_hub_session",
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "x@example.com",
    MAILGUN_FROM_NAME: "x",
    SUPPORT_EMAIL: "x@example.com",
  };
  const auth: AuthState | null = actor
    ? {
        user: actor,
        session: {
          id: "s",
          user_id: actor.id,
          token_hash: "h",
          ip_address: null,
          user_agent: null,
          expires_at: "2099-01-01T00:00:00.000Z",
          created_at: TS,
          last_activity_at: TS,
        },
      }
    : null;
  const requestInit: RequestInit = {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  return {
    request: new Request(url, requestInit),
    env,
    url,
    cookies: init.cookies ?? {},
    auth,
  };
}

async function asJson(res: Response): Promise<unknown> {
  return res.clone().json();
}

// ---------------------------------------------------------------------------
// directory-info opt-out PATCH
// ---------------------------------------------------------------------------

describe("UNI-32 / PATCH /api/students/:id/directory-info", () => {
  it("over-18 student can flip their own opt-out and writes audit", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentOver18, fix.db, {
      method: "PATCH",
      pathname: `/api/students/${STUDENT_OVER18_ROW_ID}/directory-info`,
      body: { directory_info_opt_out: true },
    });
    const res = await handleUpdateStudentDirectoryInfo(
      ctx,
      STUDENT_OVER18_ROW_ID,
    );
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: { directory_info_opt_out: boolean } };
    expect(body.data.directory_info_opt_out).toBe(true);

    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("directory_info.updated")),
    ).toBe(true);
  });

  it("under-18 student attempting self-flip is 403", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentUnder18, fix.db, {
      method: "PATCH",
      pathname: `/api/students/${STUDENT_UNDER18_ROW_ID}/directory-info`,
      body: { directory_info_opt_out: true },
    });
    const res = await handleUpdateStudentDirectoryInfo(
      ctx,
      STUDENT_UNDER18_ROW_ID,
    );
    expect(res.status).toBe(403);
  });

  it("uni admin can set the flag for an under-18 student", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "PATCH",
      pathname: `/api/students/${STUDENT_UNDER18_ROW_ID}/directory-info`,
      body: { directory_info_opt_out: true },
    });
    const res = await handleUpdateStudentDirectoryInfo(
      ctx,
      STUDENT_UNDER18_ROW_ID,
    );
    expect(res.status).toBe(200);
  });

  it("uni admin in the wrong university gets 403", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "PATCH",
      pathname: `/api/students/${STUDENT_OTHER_UNI_ROW_ID}/directory-info`,
      body: { directory_info_opt_out: true },
    });
    const res = await handleUpdateStudentDirectoryInfo(
      ctx,
      STUDENT_OTHER_UNI_ROW_ID,
    );
    expect(res.status).toBe(403);
  });

  it("a faculty actor cannot set the flag (not in the allowed set)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAFaculty, fix.db, {
      method: "PATCH",
      pathname: `/api/students/${STUDENT_OVER18_ROW_ID}/directory-info`,
      body: { directory_info_opt_out: true },
    });
    const res = await handleUpdateStudentDirectoryInfo(
      ctx,
      STUDENT_OVER18_ROW_ID,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// disclosure consents
// ---------------------------------------------------------------------------

describe("UNI-32 / disclosure consents", () => {
  it("over-18 student grants their own consent, audit recorded", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentOver18, fix.db, {
      method: "POST",
      pathname: "/api/disclosure-consents",
      body: {
        student_user_id: STUDENT_OVER18_ID,
        requester: "Acme Scholarship",
        purpose: "Verify enrollment + GPA for scholarship.",
        data_categories: ["grades", "transcript"],
      },
    });
    const res = await handleCreateDisclosureConsent(ctx);
    expect(res.status).toBe(201);
    expect(fix.consents.size).toBe(1);
    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("disclosure_consent.granted")),
    ).toBe(true);
  });

  it("under-18 student cannot grant consent themselves", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentUnder18, fix.db, {
      method: "POST",
      pathname: "/api/disclosure-consents",
      body: {
        student_user_id: STUDENT_UNDER18_ID,
        requester: "Acme Scholarship",
        purpose: "Verify enrollment + GPA.",
        data_categories: ["grades"],
      },
    });
    const res = await handleCreateDisclosureConsent(ctx);
    expect(res.status).toBe(403);
  });

  it("admin can grant consent on a student's behalf", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "POST",
      pathname: "/api/disclosure-consents",
      body: {
        student_user_id: STUDENT_UNDER18_ID,
        requester: "Parent-signed paper consent",
        purpose: "Disclose grades to a tutor referenced on the paper form.",
        data_categories: ["grades"],
      },
    });
    const res = await handleCreateDisclosureConsent(ctx);
    expect(res.status).toBe(201);
  });

  it("student can list only their own consents", async () => {
    const fix = seedFixture();
    // Pre-seed a consent for student over 18.
    fix.consents.set("77777777-aaaa-0000-0000-000000000001", {
      id: "77777777-aaaa-0000-0000-000000000001",
      student_user_id: STUDENT_OVER18_ID,
      university_id: UNI_A,
      requester: "X",
      purpose: "Y",
      data_categories: JSON.stringify(["grades"]),
      granted_at: TS,
      granted_by_user_id: STUDENT_OVER18_ID,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      created_at: TS,
      updated_at: TS,
    });
    fix.consents.set("77777777-aaaa-0000-0000-000000000002", {
      id: "77777777-aaaa-0000-0000-000000000002",
      student_user_id: STUDENT_UNDER18_ID,
      university_id: UNI_A,
      requester: "Z",
      purpose: "W",
      data_categories: JSON.stringify(["grades"]),
      granted_at: TS,
      granted_by_user_id: UNI_A_ADMIN_ID,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      created_at: TS,
      updated_at: TS,
    });

    const ctx = makeCtx(ACTORS.studentOver18, fix.db, {
      pathname: "/api/disclosure-consents",
    });
    const res = await handleListDisclosureConsents(ctx);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: { id: string }[] };
    expect(body.data.map((c) => c.id)).toEqual(["77777777-aaaa-0000-0000-000000000001"]);
  });

  it("revoke flips revoked_at + audits", async () => {
    const fix = seedFixture();
    fix.consents.set("77777777-aaaa-0000-0000-000000000001", {
      id: "77777777-aaaa-0000-0000-000000000001",
      student_user_id: STUDENT_OVER18_ID,
      university_id: UNI_A,
      requester: "X",
      purpose: "Y",
      data_categories: JSON.stringify(["grades"]),
      granted_at: TS,
      granted_by_user_id: STUDENT_OVER18_ID,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      created_at: TS,
      updated_at: TS,
    });

    const ctx = makeCtx(ACTORS.studentOver18, fix.db, {
      method: "POST",
      pathname: "/api/disclosure-consents/c1/revoke",
    });
    const res = await handleRevokeDisclosureConsent(ctx, "77777777-aaaa-0000-0000-000000000001");
    expect(res.status).toBe(200);
    expect(fix.consents.get("77777777-aaaa-0000-0000-000000000001")?.revoked_at).not.toBeNull();
    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("disclosure_consent.revoked")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disclosure log
// ---------------------------------------------------------------------------

describe("UNI-32 / disclosure log", () => {
  it("admin recording a release without a consent reference is 400", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "POST",
      pathname: "/api/disclosures",
      body: {
        consent_id: "00000000-0000-0000-0000-000000000099",
        released_to: "Some Office",
        data_categories: ["grades"],
      },
    });
    const res = await handleRecordDisclosure(ctx);
    expect(res.status).toBe(400);
    const body = (await asJson(res)) as { error: { code: string } };
    expect(body.error.code).toBe("consent_required");
  });

  it("admin recording a release with a revoked consent is 400", async () => {
    const fix = seedFixture();
    fix.consents.set("77777777-aaaa-0000-0000-000000000001", {
      id: "77777777-aaaa-0000-0000-000000000001",
      student_user_id: STUDENT_OVER18_ID,
      university_id: UNI_A,
      requester: "X",
      purpose: "Y",
      data_categories: JSON.stringify(["grades"]),
      granted_at: TS,
      granted_by_user_id: STUDENT_OVER18_ID,
      expires_at: null,
      revoked_at: TS,
      revoked_by_user_id: STUDENT_OVER18_ID,
      created_at: TS,
      updated_at: TS,
    });
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "POST",
      pathname: "/api/disclosures",
      body: {
        consent_id: "77777777-aaaa-0000-0000-000000000001",
        released_to: "Some Office",
        data_categories: ["grades"],
      },
    });
    const res = await handleRecordDisclosure(ctx);
    expect(res.status).toBe(400);
  });

  it("admin recording a release with a valid consent succeeds and audits", async () => {
    const fix = seedFixture();
    fix.consents.set("77777777-aaaa-0000-0000-000000000001", {
      id: "77777777-aaaa-0000-0000-000000000001",
      student_user_id: STUDENT_OVER18_ID,
      university_id: UNI_A,
      requester: "X",
      purpose: "Y",
      data_categories: JSON.stringify(["grades", "transcript"]),
      granted_at: TS,
      granted_by_user_id: STUDENT_OVER18_ID,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      created_at: TS,
      updated_at: TS,
    });
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "POST",
      pathname: "/api/disclosures",
      body: {
        consent_id: "77777777-aaaa-0000-0000-000000000001",
        released_to: "Acme Scholarship",
        data_categories: ["grades"],
      },
    });
    const res = await handleRecordDisclosure(ctx);
    expect(res.status).toBe(201);
    const audits = fix.db.inserts("audit_logs");
    expect(audits.some((e) => e.params.includes("disclosure.released"))).toBe(
      true,
    );
    expect(fix.db.inserts("disclosure_log")).toHaveLength(1);
  });

  it("recording a release with a category outside the consent is 400", async () => {
    const fix = seedFixture();
    fix.consents.set("77777777-aaaa-0000-0000-000000000001", {
      id: "77777777-aaaa-0000-0000-000000000001",
      student_user_id: STUDENT_OVER18_ID,
      university_id: UNI_A,
      requester: "X",
      purpose: "Y",
      data_categories: JSON.stringify(["grades"]),
      granted_at: TS,
      granted_by_user_id: STUDENT_OVER18_ID,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      created_at: TS,
      updated_at: TS,
    });
    const ctx = makeCtx(ACTORS.uniAAdmin, fix.db, {
      method: "POST",
      pathname: "/api/disclosures",
      body: {
        consent_id: "77777777-aaaa-0000-0000-000000000001",
        released_to: "Acme Scholarship",
        data_categories: ["grades", "disciplinary"],
      },
    });
    const res = await handleRecordDisclosure(ctx);
    expect(res.status).toBe(400);
    const body = (await asJson(res)) as { error: { code: string } };
    expect(body.error.code).toBe("categories_outside_consent");
  });

  it("non-admin (staff) cannot record a disclosure", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAStaff, fix.db, {
      method: "POST",
      pathname: "/api/disclosures",
      body: {
        consent_id: "00000000-0000-0000-0000-000000000099",
        released_to: "x",
        data_categories: ["grades"],
      },
    });
    const res = await handleRecordDisclosure(ctx);
    expect(res.status).toBe(403);
  });

  it("staff cannot list the disclosure log either", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.uniAStaff, fix.db, {
      pathname: "/api/disclosures",
    });
    const res = await handleListDisclosures(ctx);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// parent sign-in flow
// ---------------------------------------------------------------------------

describe("UNI-32 / parent sign-in flow", () => {
  it("request always 202s — even when the email matches no student", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(null, fix.db, {
      method: "POST",
      pathname: "/api/parent/sign-in/request",
      body: { parent_email: "stranger@example.com" },
    });
    const res = await handleParentSignInRequest(ctx);
    expect(res.status).toBe(202);
    // No token issued.
    expect(fix.parentTokens.size).toBe(0);
  });

  it("request issues a token + audit when the email matches an under-18 student", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(null, fix.db, {
      method: "POST",
      pathname: "/api/parent/sign-in/request",
      body: { parent_email: PARENT_EMAIL },
    });
    const res = await handleParentSignInRequest(ctx);
    expect(res.status).toBe(202);
    expect(fix.parentTokens.size).toBe(1);
    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("parent.sign_in_requested")),
    ).toBe(true);
  });

  it("verify with a wrong token is 401", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(null, fix.db, {
      method: "POST",
      pathname: "/api/parent/sign-in/verify",
      body: { parent_email: PARENT_EMAIL, token: "not-a-real-token" },
    });
    const res = await handleParentSignInVerify(ctx);
    expect(res.status).toBe(401);
  });

  it("verify with the issued token creates a session and binds to the student", async () => {
    const fix = seedFixture();

    // First, request to mint a token. We need to grab the raw token, which
    // the route emits in the email — but we don't capture emails here.
    // Instead we issue the token directly through the helper.
    const { issueParentToken, createParentSession } = await import(
      "../../src/auth/parent-session.js"
    );
    const issued = await issueParentToken(
      fix.db as unknown as D1Database,
      {
        studentUserId: STUDENT_UNDER18_ID,
        parentEmail: PARENT_EMAIL,
      },
    );

    const ctx = makeCtx(null, fix.db, {
      method: "POST",
      pathname: "/api/parent/sign-in/verify",
      body: { parent_email: PARENT_EMAIL, token: issued.token },
    });
    const res = await handleParentSignInVerify(ctx);
    expect(res.status).toBe(200);
    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("parent.sign_in_verified")),
    ).toBe(true);
    expect(fix.parentSessions.size).toBe(1);

    // Token was consumed (single-use).
    expect(fix.parentTokens.size).toBe(0);

    // The set-cookie header carries the session token.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.includes(PARENT_SESSION_COOKIE + "=")).toBe(true);

    void createParentSession; // silence unused import
  });

  it("parent /me with a valid cookie returns the bound student", async () => {
    const fix = seedFixture();
    const { createParentSession } = await import(
      "../../src/auth/parent-session.js"
    );
    const created = await createParentSession(
      fix.db as unknown as D1Database,
      {
        studentUserId: STUDENT_UNDER18_ID,
        parentEmail: PARENT_EMAIL,
      },
    );
    const ctx = makeCtx(null, fix.db, {
      pathname: "/api/parent/me",
      cookies: { [PARENT_SESSION_COOKIE]: created.token },
    });
    const res = await handleParentMe(ctx);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as {
      data: { student: { student_user_id: string }; parent_email: string };
    };
    expect(body.data.student.student_user_id).toBe(STUDENT_UNDER18_ID);
    expect(body.data.parent_email).toBe(PARENT_EMAIL);
  });

  it("parent /grades with no cookie is 401", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(null, fix.db, { pathname: "/api/parent/grades" });
    const res = await handleParentGrades(ctx);
    expect(res.status).toBe(401);
  });

  it("parent sign-out removes the session", async () => {
    const fix = seedFixture();
    const { createParentSession } = await import(
      "../../src/auth/parent-session.js"
    );
    const created = await createParentSession(
      fix.db as unknown as D1Database,
      {
        studentUserId: STUDENT_UNDER18_ID,
        parentEmail: PARENT_EMAIL,
      },
    );
    const ctx = makeCtx(null, fix.db, {
      method: "POST",
      pathname: "/api/parent/sign-out",
      cookies: { [PARENT_SESSION_COOKIE]: created.token },
    });
    const res = await handleParentSignOut(ctx);
    expect(res.status).toBe(200);
    expect(fix.parentSessions.size).toBe(0);
  });
});

// hashToken is exported just so we can exercise it once and get a sanity
// check that the helper is wired into the bundle (some tests use it via the
// helper, but having one direct call protects against accidental tree-
// shaking when the test file imports the module).
void hashToken;
