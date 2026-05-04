-- 0001_initial_schema.sql
--
-- Initial schema for University Hub v2. Source: epic UNI-1 §18 (tables) and §19
-- (indexes). D1 is SQLite under the hood; only TEXT / INTEGER / REAL types are
-- used. Primary keys are UUIDs stored as TEXT (generated via `crypto.randomUUID()`
-- in the Worker — see docs/database.md). Timestamps are ISO-8601 strings in UTC.
--
-- Foreign keys are declared for documentation and local enforcement, but D1 only
-- enforces them when `PRAGMA foreign_keys = ON` is set on the connection.
-- The Worker DB helper (apps/worker/src/db/index.ts) does this on first use.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- universities
-- ---------------------------------------------------------------------------
CREATE TABLE universities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','inactive','archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL
                  CHECK (role IN (
                    'super_admin','university_admin','staff','faculty',
                    'teacher','teacher_assistant','student','guest','viewer'
                  )),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('active','inactive','suspended','pending')),
  university_id   TEXT REFERENCES universities(id) ON DELETE SET NULL,
  last_sign_in_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  ip_address  TEXT,
  user_agent  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL
                CHECK (role IN (
                  'super_admin','university_admin','staff','faculty',
                  'teacher','teacher_assistant','student','guest','viewer'
                )),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','expired','revoked')),
  token_hash    TEXT NOT NULL UNIQUE,
  university_id TEXT REFERENCES universities(id) ON DELETE CASCADE,
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
  id            TEXT PRIMARY KEY,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          TEXT,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (university_id, code)
);

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------
CREATE TABLE courses (
  id            TEXT PRIMARY KEY,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  code          TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive','archived')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  university_id   TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  student_number  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (university_id, student_number)
);

-- ---------------------------------------------------------------------------
-- faculty
-- ---------------------------------------------------------------------------
CREATE TABLE faculty (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  title         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- teachers
-- ---------------------------------------------------------------------------
CREATE TABLE teachers (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  title         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- teacher_assistants
-- ---------------------------------------------------------------------------
CREATE TABLE teacher_assistants (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- course_assignments — links a user to a course in a specific role.
-- ---------------------------------------------------------------------------
CREATE TABLE course_assignments (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL
              CHECK (role IN ('faculty','teacher','teacher_assistant','student','viewer')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (course_id, user_id, role)
);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  university_id   TEXT REFERENCES universities(id) ON DELETE SET NULL,
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- contact_messages
-- ---------------------------------------------------------------------------
CREATE TABLE contact_messages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','reviewed','archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Indexes (epic §19) — common lookup paths.
-- ---------------------------------------------------------------------------

-- users
CREATE INDEX idx_users_role           ON users(role);
CREATE INDEX idx_users_status         ON users(status);
CREATE INDEX idx_users_university_id  ON users(university_id);

-- sessions
CREATE INDEX idx_sessions_user_id     ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at  ON sessions(expires_at);

-- invitations
CREATE INDEX idx_invitations_email          ON invitations(email);
CREATE INDEX idx_invitations_status         ON invitations(status);
CREATE INDEX idx_invitations_university_id  ON invitations(university_id);
CREATE INDEX idx_invitations_invited_by     ON invitations(invited_by);
CREATE INDEX idx_invitations_expires_at     ON invitations(expires_at);

-- universities
CREATE INDEX idx_universities_status ON universities(status);

-- departments
CREATE INDEX idx_departments_university_id ON departments(university_id);

-- courses
CREATE INDEX idx_courses_university_id ON courses(university_id);
CREATE INDEX idx_courses_department_id ON courses(department_id);
CREATE INDEX idx_courses_status        ON courses(status);

-- students
CREATE INDEX idx_students_university_id ON students(university_id);
CREATE INDEX idx_students_department_id ON students(department_id);

-- faculty
CREATE INDEX idx_faculty_university_id ON faculty(university_id);
CREATE INDEX idx_faculty_department_id ON faculty(department_id);

-- teachers
CREATE INDEX idx_teachers_university_id ON teachers(university_id);
CREATE INDEX idx_teachers_department_id ON teachers(department_id);

-- teacher_assistants
CREATE INDEX idx_teacher_assistants_university_id ON teacher_assistants(university_id);
CREATE INDEX idx_teacher_assistants_department_id ON teacher_assistants(department_id);

-- course_assignments
CREATE INDEX idx_course_assignments_course_id ON course_assignments(course_id);
CREATE INDEX idx_course_assignments_user_id   ON course_assignments(user_id);
CREATE INDEX idx_course_assignments_role      ON course_assignments(role);

-- audit_logs
CREATE INDEX idx_audit_logs_university_id ON audit_logs(university_id);
CREATE INDEX idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_action        ON audit_logs(action);
CREATE INDEX idx_audit_logs_entity        ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at    ON audit_logs(created_at);

-- contact_messages
CREATE INDEX idx_contact_messages_status     ON contact_messages(status);
CREATE INDEX idx_contact_messages_created_at ON contact_messages(created_at);
