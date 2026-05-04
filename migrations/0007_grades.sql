-- 0007_grades.sql
--
-- Assessments + grades + FERPA record-of-access (epic UNI-21 / sub-issue
-- UNI-30). The issue body specifies "0005_grades.sql" but 0005 was already
-- consumed by the rate-limit counters migration (sub-issue UNI-25). We pick
-- up the next free slot.
--
--   * `assessments`       — grade-bearing items inside a course (homework,
--                           midterm, project, etc.). Soft-deleted via
--                           `deleted_at` so historical grade rows referring
--                           to them don't lose their context.
--   * `grades`            — one row per (assessment, student). Score is
--                           nullable so faculty can pre-create rows in
--                           "pending" state before grading. `letter_grade`
--                           is stored verbatim (no automatic computation in
--                           this iteration — see issue out-of-scope).
--   * `grade_access_log`  — append-only FERPA record-of-disclosure surface.
--                           Every read of grade data writes one row here,
--                           and the admin record-of-access page consumes it.
--                           This table is intentionally NOT routed through
--                           `audit_logs` — FERPA wants a dedicated audit of
--                           grade DISCLOSURE, distinct from the operational
--                           audit log that tracks mutations.
--
-- Index choices:
--   * `(assessment_id, student_user_id)` UNIQUE — natural key; enforces
--     "one grade per student per assessment".
--   * `(course_id)` on assessments + grade_access_log — gradebook view +
--     admin record-of-access course filter both fan out from a course.
--   * `(student_user_id)` on grades + grade_access_log — student-self view
--     and admin filter "who has been looking at student X".
--   * `(viewer_user_id)` on grade_access_log — admin filter "what has user
--     Y been seeing".

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- assessments
-- ---------------------------------------------------------------------------
CREATE TABLE assessments (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  weight       REAL NOT NULL DEFAULT 0
                CHECK (weight >= 0 AND weight <= 1),
  max_score    REAL NOT NULL DEFAULT 100
                CHECK (max_score > 0),
  due_at       TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_assessments_course_id  ON assessments(course_id);
CREATE INDEX idx_assessments_deleted_at ON assessments(deleted_at);

-- ---------------------------------------------------------------------------
-- grades — one row per (assessment, student)
-- ---------------------------------------------------------------------------
CREATE TABLE grades (
  id                 TEXT PRIMARY KEY,
  assessment_id      TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score              REAL,
  letter_grade       TEXT,
  feedback           TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('graded','pending','excused')),
  graded_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  graded_at          TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (assessment_id, student_user_id)
);

CREATE INDEX idx_grades_assessment_id   ON grades(assessment_id);
CREATE INDEX idx_grades_student_user_id ON grades(student_user_id);
CREATE INDEX idx_grades_status          ON grades(status);

-- ---------------------------------------------------------------------------
-- grade_access_log — FERPA record-of-disclosure
--
-- Append-only. One row per *grade row read*; bulk reads (a gradebook view
-- of N students) emit N rows so the admin page can answer "who has seen
-- student X's grades" without having to expand a logged "course view" into
-- per-student rows after the fact.
--
-- `viewed_grade_id` is nullable because faculty can legitimately read a
-- gradebook before any grade row exists for a given (assessment, student)
-- pair — the disclosure of "this student has no grade yet for assessment Y"
-- is itself a disclosure FERPA cares about. In that case we log
-- `assessment_id` + `viewed_student_user_id` and leave the grade id null.
-- ---------------------------------------------------------------------------
CREATE TABLE grade_access_log (
  id                     TEXT PRIMARY KEY,
  viewer_user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  viewer_role            TEXT NOT NULL,
  viewer_course_role     TEXT,
  course_id              TEXT REFERENCES courses(id) ON DELETE SET NULL,
  assessment_id          TEXT REFERENCES assessments(id) ON DELETE SET NULL,
  viewed_grade_id        TEXT REFERENCES grades(id) ON DELETE SET NULL,
  viewed_student_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  context                TEXT NOT NULL,
  accessed_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_grade_access_log_viewer_user_id     ON grade_access_log(viewer_user_id);
CREATE INDEX idx_grade_access_log_viewed_student     ON grade_access_log(viewed_student_user_id);
CREATE INDEX idx_grade_access_log_course_id          ON grade_access_log(course_id);
CREATE INDEX idx_grade_access_log_assessment_id      ON grade_access_log(assessment_id);
CREATE INDEX idx_grade_access_log_accessed_at        ON grade_access_log(accessed_at);
