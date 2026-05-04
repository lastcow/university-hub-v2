// RBAC tests for the academic directory endpoints (UNI-13).
//
// Three things need to hold:
//   1. Cross-role denial: roles outside the directory whitelist (student,
//      guest, viewer) get a 403 from the list endpoints.
//   2. University scoping: a university_admin/staff/etc. only sees rows in
//      their own university; other-university rows return 404.
//   3. Owner pass-through: a student / teacher / TA can read their own
//      profile via /:id even though they cannot list the directory, because
//      the row matches their user_id.

import { describe, expect, it } from "vitest";

import type { Role } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleGetFaculty,
  handleListFaculty,
} from "../../src/routes/faculty.js";
import {
  handleGetStudent,
  handleListStudents,
} from "../../src/routes/students.js";
import {
  handleGetTeacherAssistant,
  handleListTeacherAssistants,
} from "../../src/routes/teacher-assistants.js";
import {
  handleGetTeacher,
  handleListTeachers,
} from "../../src/routes/teachers.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const STUDENT_USER_ID = "00000000-0000-0000-0000-00000000cccc";
const TEACHER_USER_ID = "00000000-0000-0000-0000-00000000dddd";
const TA_USER_ID = "00000000-0000-0000-0000-00000000eeee";
const FACULTY_USER_ID = "00000000-0000-0000-0000-00000000ffff";
const OTHER_STUDENT_USER_ID = "00000000-0000-0000-0000-000000000010";

const STUDENT_ROW_A_ID = "55555555-0000-0000-0000-00000000aaaa";
const STUDENT_ROW_B_ID = "55555555-0000-0000-0000-00000000bbbb";
const FACULTY_ROW_ID = "66666666-0000-0000-0000-000000000001";
const TEACHER_ROW_ID = "77777777-0000-0000-0000-000000000001";
const TA_ROW_ID = "88888888-0000-0000-0000-000000000001";

interface UserFixture {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "inactive" | "suspended" | "pending";
  university_id: string | null;
}

const SUPER_ADMIN: UserFixture = {
  id: SUPER_ADMIN_ID,
  email: "super@example.com",
  name: "Super",
  role: "super_admin",
  status: "active",
  university_id: null,
};
const UNI_A_ADMIN: UserFixture = {
  id: UNI_A_ADMIN_ID,
  email: "admin-a@example.com",
  name: "Admin A",
  role: "university_admin",
  status: "active",
  university_id: UNI_A,
};
const STUDENT_USER: UserFixture = {
  id: STUDENT_USER_ID,
  email: "student@example.com",
  name: "Student",
  role: "student",
  status: "active",
  university_id: UNI_A,
};
const TEACHER_USER: UserFixture = {
  id: TEACHER_USER_ID,
  email: "teacher@example.com",
  name: "Teacher",
  role: "teacher",
  status: "active",
  university_id: UNI_A,
};
const TA_USER: UserFixture = {
  id: TA_USER_ID,
  email: "ta@example.com",
  name: "TA",
  role: "teacher_assistant",
  status: "active",
  university_id: UNI_A,
};
const FACULTY_USER: UserFixture = {
  id: FACULTY_USER_ID,
  email: "faculty@example.com",
  name: "Faculty",
  role: "faculty",
  status: "active",
  university_id: UNI_A,
};
const GUEST_USER: UserFixture = {
  id: "00000000-0000-0000-0000-00000000gggg",
  email: "guest@example.com",
  name: "Guest",
  role: "guest",
  status: "active",
  university_id: UNI_A,
};

interface StudentRow {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  student_number: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}

interface FacultyRow {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}

interface TeacherRow extends FacultyRow {}
interface TaRow {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}

const TS = "2026-05-04T00:00:00.000Z";

const STUDENT_ROWS: StudentRow[] = [
  {
    id: STUDENT_ROW_A_ID,
    user_id: STUDENT_USER_ID,
    university_id: UNI_A,
    department_id: null,
    student_number: "S001",
    created_at: TS,
    updated_at: TS,
    name: STUDENT_USER.name,
    email: STUDENT_USER.email,
    university_name: "Uni A",
    department_name: null,
  },
  {
    id: STUDENT_ROW_B_ID,
    user_id: OTHER_STUDENT_USER_ID,
    university_id: UNI_B,
    department_id: null,
    student_number: "S002",
    created_at: TS,
    updated_at: TS,
    name: "Other Student",
    email: "other@example.com",
    university_name: "Uni B",
    department_name: null,
  },
];

const FACULTY_ROWS: FacultyRow[] = [
  {
    id: FACULTY_ROW_ID,
    user_id: FACULTY_USER_ID,
    university_id: UNI_A,
    department_id: null,
    title: "Professor",
    created_at: TS,
    updated_at: TS,
    name: FACULTY_USER.name,
    email: FACULTY_USER.email,
    university_name: "Uni A",
    department_name: null,
  },
];

const TEACHER_ROWS: TeacherRow[] = [
  {
    id: TEACHER_ROW_ID,
    user_id: TEACHER_USER_ID,
    university_id: UNI_A,
    department_id: null,
    title: "Lecturer",
    created_at: TS,
    updated_at: TS,
    name: TEACHER_USER.name,
    email: TEACHER_USER.email,
    university_name: "Uni A",
    department_name: null,
  },
];

const TA_ROWS: TaRow[] = [
  {
    id: TA_ROW_ID,
    user_id: TA_USER_ID,
    university_id: UNI_A,
    department_id: null,
    created_at: TS,
    updated_at: TS,
    name: TA_USER.name,
    email: TA_USER.email,
    university_name: "Uni A",
    department_name: null,
  },
];

function makeDb(): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onAll((sql, params) => {
    if (sql.includes("FROM students s") && sql.includes("ORDER BY u.name")) {
      let rows = [...STUDENT_ROWS];
      if (sql.includes("s.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      return rows;
    }
    if (sql.includes("FROM faculty f") && sql.includes("ORDER BY u.name")) {
      let rows = [...FACULTY_ROWS];
      if (sql.includes("f.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      return rows;
    }
    if (sql.includes("FROM teachers t") && sql.includes("ORDER BY u.name")) {
      let rows = [...TEACHER_ROWS];
      if (sql.includes("t.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      return rows;
    }
    if (sql.includes("FROM teacher_assistants ta") && sql.includes("ORDER BY u.name")) {
      let rows = [...TA_ROWS];
      if (sql.includes("ta.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      return rows;
    }
    return undefined;
  });
  db.onFirst((sql, params) => {
    if (sql.includes("FROM students s") && sql.includes("WHERE s.id = ?")) {
      return STUDENT_ROWS.find((r) => r.id === params[0]) ?? null;
    }
    if (sql.includes("FROM students s") && sql.includes("WHERE s.user_id = ?")) {
      return STUDENT_ROWS.find((r) => r.user_id === params[0]) ?? null;
    }
    if (sql.includes("FROM faculty f") && sql.includes("WHERE f.id = ?")) {
      return FACULTY_ROWS.find((r) => r.id === params[0]) ?? null;
    }
    if (sql.includes("FROM faculty f") && sql.includes("WHERE f.user_id = ?")) {
      return FACULTY_ROWS.find((r) => r.user_id === params[0]) ?? null;
    }
    if (sql.includes("FROM teachers t") && sql.includes("WHERE t.id = ?")) {
      return TEACHER_ROWS.find((r) => r.id === params[0]) ?? null;
    }
    if (sql.includes("FROM teachers t") && sql.includes("WHERE t.user_id = ?")) {
      return TEACHER_ROWS.find((r) => r.user_id === params[0]) ?? null;
    }
    if (sql.includes("FROM teacher_assistants ta") && sql.includes("WHERE ta.id = ?")) {
      return TA_ROWS.find((r) => r.id === params[0]) ?? null;
    }
    if (sql.includes("FROM teacher_assistants ta") && sql.includes("WHERE ta.user_id = ?")) {
      return TA_ROWS.find((r) => r.user_id === params[0]) ?? null;
    }
    return undefined;
  });
  return db;
}

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    SUPPORT_EMAIL: "support@example.com",
  };
}

function ctx(actor: UserFixture, db: ProgrammableD1, path = "/api/students"): RequestContext {
  const url = new URL(`https://hub.example.com${path}`);
  const request = new Request(url, { method: "GET" });
  const env = makeEnv(db);
  const auth: AuthState = {
    user: { ...actor, password_hash: "x" } as unknown as UserRow,
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
  return { request, env, url, cookies: {}, auth };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("Directory list endpoints — cross-role denial", () => {
  it.each([
    ["students", handleListStudents],
    ["faculty", handleListFaculty],
    ["teachers", handleListTeachers],
    ["teacher-assistants", handleListTeacherAssistants],
  ])("a student gets 403 from /api/%s", async (_, handler) => {
    const db = makeDb();
    const res = await handler(ctx(STUDENT_USER, db));
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("forbidden");
  });

  it.each([
    ["students", handleListStudents],
    ["faculty", handleListFaculty],
    ["teachers", handleListTeachers],
    ["teacher-assistants", handleListTeacherAssistants],
  ])("a guest gets 403 from /api/%s", async (_, handler) => {
    const db = makeDb();
    const res = await handler(ctx(GUEST_USER, db));
    expect(res.status).toBe(403);
  });
});

describe("Directory list endpoints — university scoping", () => {
  it("super_admin sees rows from every university", async () => {
    const db = makeDb();
    const res = await handleListStudents(ctx(SUPER_ADMIN, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data.length).toBe(STUDENT_ROWS.length);
  });

  it("university_admin only sees rows in their own university", async () => {
    const db = makeDb();
    const res = await handleListStudents(ctx(UNI_A_ADMIN, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ university_id: string }> }>(res);
    expect(body.data.length).toBe(1);
    for (const row of body.data) {
      expect(row.university_id).toBe(UNI_A);
    }
  });

  it("teacher (academic role) can see students in their own university", async () => {
    const db = makeDb();
    const res = await handleListStudents(ctx(TEACHER_USER, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ university_id: string }> }>(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.university_id).toBe(UNI_A);
  });
});

describe("Directory detail — cross-university access returns 404", () => {
  it("UNI_A admin cannot read a student in UNI_B", async () => {
    const db = makeDb();
    const res = await handleGetStudent(ctx(UNI_A_ADMIN, db), STUDENT_ROW_B_ID);
    expect(res.status).toBe(404);
  });
});

describe("Directory detail — owner can read their own row even without directory access", () => {
  it("a student can read their own student row by id", async () => {
    const db = makeDb();
    const res = await handleGetStudent(ctx(STUDENT_USER, db), STUDENT_ROW_A_ID);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { user_id: string } }>(res);
    expect(body.data.user_id).toBe(STUDENT_USER_ID);
  });

  it("a student cannot read another student's row", async () => {
    const db = makeDb();
    const res = await handleGetStudent(ctx(STUDENT_USER, db), STUDENT_ROW_B_ID);
    expect(res.status).toBe(404);
  });

  it("a teacher can read their own teacher row", async () => {
    const db = makeDb();
    const res = await handleGetTeacher(ctx(TEACHER_USER, db), TEACHER_ROW_ID);
    expect(res.status).toBe(200);
  });

  it("a TA can read their own TA row", async () => {
    const db = makeDb();
    const res = await handleGetTeacherAssistant(ctx(TA_USER, db), TA_ROW_ID);
    expect(res.status).toBe(200);
  });

  it("a faculty member can read their own faculty row", async () => {
    const db = makeDb();
    const res = await handleGetFaculty(ctx(FACULTY_USER, db), FACULTY_ROW_ID);
    expect(res.status).toBe(200);
  });
});
