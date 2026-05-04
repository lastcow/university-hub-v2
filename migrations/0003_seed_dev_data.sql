-- 0003_seed_dev_data.sql
--
-- Dev-only seed (epic UNI-1 §35). Creates a demo university, a super_admin
-- with a known dev password, demo users for each role, demo departments and
-- courses. Apply with `wrangler d1 migrations apply DB --local`.
--
-- The dev super_admin login (used by QA for local smoke tests):
--   email:    superadmin@dev.local
--   password: DevSuperAdmin!2026
--
-- All demo users share the same password (`DevSuperAdmin!2026`) for
-- convenience — these creds are dev-only, never run this migration in
-- production. The `password_hash` below was generated with:
--   node scripts/hash-password.mjs 'DevSuperAdmin!2026'
-- which uses the same PBKDF2-SHA256 path as apps/worker/src/auth/password.ts.
--
-- All UUIDs are fixed so re-running gives deterministic IDs, and the seed is
-- guarded by INSERT OR IGNORE so it is idempotent if applied twice locally.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Demo university
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO universities (id, name, slug, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Demo University', 'demo-university', 'active');

-- ---------------------------------------------------------------------------
-- Demo users — all share the same dev password.
-- Password: DevSuperAdmin!2026
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO users (id, email, password_hash, name, role, status, university_id) VALUES
  ('22222222-0000-0000-0000-000000000001', 'superadmin@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Super Admin', 'super_admin', 'active', NULL),
  ('22222222-0000-0000-0000-000000000002', 'uniadmin@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev University Admin', 'university_admin', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000003', 'staff@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Staff', 'staff', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000004', 'faculty@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Faculty', 'faculty', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000005', 'teacher@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Teacher', 'teacher', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000006', 'ta@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Teacher Assistant', 'teacher_assistant', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000007', 'student@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Student', 'student', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000008', 'guest@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Guest', 'guest', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000009', 'viewer@dev.local',
   'pbkdf2-sha256$100000$noFoklSC/jaXF5QQeJ6LnQ==$z5dWOwrmHHtSJ8EbVBsGx3I8QxM1ff/QNIeGNDBGwrE=',
   'Dev Viewer', 'viewer', 'active', '11111111-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- Demo departments
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO departments (id, university_id, name, code, description) VALUES
  ('33333333-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   'Computer Science', 'CS',
   'Department of Computer Science'),
  ('33333333-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001',
   'Mathematics', 'MATH',
   'Department of Mathematics');

-- ---------------------------------------------------------------------------
-- Demo courses
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO courses (id, university_id, department_id, name, code, description, status) VALUES
  ('44444444-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001',
   'Intro to Programming', 'CS101',
   'Foundational course in programming', 'active'),
  ('44444444-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001',
   'Data Structures', 'CS201',
   'Core data structures and algorithms', 'active'),
  ('44444444-0000-0000-0000-000000000003',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000002',
   'Calculus I', 'MATH101',
   'Differential calculus', 'active');

-- ---------------------------------------------------------------------------
-- Role-specific profile rows
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO faculty (id, user_id, university_id, department_id, title) VALUES
  ('55555555-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000004',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001',
   'Associate Professor');

INSERT OR IGNORE INTO teachers (id, user_id, university_id, department_id, title) VALUES
  ('66666666-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001',
   'Lecturer');

INSERT OR IGNORE INTO teacher_assistants (id, user_id, university_id, department_id) VALUES
  ('77777777-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001');

INSERT OR IGNORE INTO students (id, user_id, university_id, department_id, student_number) VALUES
  ('88888888-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001',
   'S0000001');

-- ---------------------------------------------------------------------------
-- Demo course assignments
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO course_assignments (id, course_id, user_id, role) VALUES
  ('99999999-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000004',
   'faculty'),
  ('99999999-0000-0000-0000-000000000002',
   '44444444-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000005',
   'teacher'),
  ('99999999-0000-0000-0000-000000000003',
   '44444444-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000006',
   'teacher_assistant'),
  ('99999999-0000-0000-0000-000000000004',
   '44444444-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000007',
   'student');
