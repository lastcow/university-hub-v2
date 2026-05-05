// LMS reconciliation engine (epic UNI-50 / sub-issue UNI-56).
//
// Replaces the placeholder runner that shipped with UNI-55. The engine
// fetches courses + enrollments via the registered provider and upserts
// them into Hub:
//
//   - Courses match by `(external_provider, external_id)`; manual edits
//     since the last sync are flagged as conflicts (LMS still wins, per
//     the epic's locked decisions).
//   - Students match by `(external_provider, external_id)` first, then
//     by `lower(email) + university_id`. Unknown students are auto-
//     created as `users` rows with `status = 'pending'` AND NO
//     INVITATION EMAIL — that is a permanent invariant of Phase 1
//     (locked by user 2026-05-05; Phase 2 will add an admin-triggered
//     bulk-invitation UI). The engine never imports the mail module;
//     that is also how we statically prove the invariant.
//   - Faculty and TAs are matched only — never auto-created. A faculty
//     enrollment whose Hub user does not exist is recorded as a
//     per-row error and skipped.
//   - Each new student gets a `disclosure_log` row under FERPA §99.32
//     (basis = `school_official_exception`), because importing the
//     directory information into Hub is a disclosure to a school
//     official under §99.31(a)(1).
//   - Drops: any LMS-sourced `course_assignments` row for the course
//     whose external id is no longer present in the new roster is soft-
//     deleted (status flipped to `dropped`, `last_synced_at` bumped).
//     The row is preserved so the audit trail and the FERPA chain are
//     not broken by a re-sync.
//
// Atomicity: each course is processed sequentially. A per-course
// failure rolls into `errors[]` and the run continues; if any course
// succeeded the run lands in `partial` instead of `failed`. Workers D1
// does not expose interactive transactions, so within a course the
// writes happen sequentially — a mid-course failure can leave a
// course's enrollments partially written. This is intentional: the
// next sync re-runs reconciliation idempotently and self-heals.
//
// All audit rows are written via `writeAuditLog` (failures swallowed,
// per the audit service's contract). The engine is otherwise
// side-effect-free at the module level: tests can construct it with a
// fake D1 + fake provider and assert on writes through the helpers in
// `apps/worker/test/helpers/programmable-d1.ts`.

import type {
  LmsConnection,
  LmsCourse,
  LmsEnrollment,
  LmsProviderId,
  LmsSyncConflict,
  LmsSyncError,
  LmsSyncRunProgress,
  LmsSyncRunStatus,
  LmsSyncSummary,
} from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import { writeAuditLog } from "../services/audit.js";
import type { LmsProvider } from "./provider.js";

/** Sentinel password hash written to LMS-imported `users` rows. The
 *  format does not match the canonical `pbkdf2-sha256$<iter>$<salt>$<hash>`
 *  shape used by `auth/password.ts`, so `verifyPassword` returns false
 *  on every comparison. Result: an LMS-imported account cannot sign in
 *  with any password until a future credential flow rewrites the hash.
 *  The literal string is matched on so a future reissue path can find
 *  these accounts cheaply. */
export const LMS_PENDING_PASSWORD_HASH = "lms-pending-no-password";

/** Static categories every system-attributed disclosure entry covers.
 *  Imports do not (yet) carry grades or financial aid; if the engine
 *  ever pulls those, this list grows. */
const DEFAULT_DISCLOSURE_CATEGORIES = ["directory", "other"] as const;

export interface ReconciliationDeps {
  db: D1Database;
  provider: LmsProvider;
}

export interface ReconciliationInput {
  syncRunId: string;
  /** Authenticated user who triggered the sync (used as the actor on
   *  audit rows so audit trail joins back to a real human). */
  actorUserId: string;
  /** Connection with decrypted tokens. The engine never persists
   *  plaintext token data — only the connection's id / university /
   *  provider id and the term cursor are written through. */
  connection: LmsConnection;
  termId: string;
  /** Display label for the term, captured at run-start by the route
   *  layer from the cached term list. Threaded through so audit rows
   *  carry it without a second LMS round-trip. */
  termName: string | null;
  /** Optional progress callback. The route layer wires this to the
   *  `lms_sync_runs.summary_json.progress` UPDATE so the polling UI
   *  sees real-time per-course progress. */
  onProgress?: (progress: LmsSyncRunProgress) => Promise<void>;
}

export interface ReconciliationResult {
  status: Extract<LmsSyncRunStatus, "success" | "partial" | "failed">;
  summary: LmsSyncSummary;
  errors: LmsSyncError[];
  conflicts: LmsSyncConflict[];
}

interface CourseRow extends Row {
  id: string;
  university_id: string;
  external_provider: string | null;
  external_id: string | null;
  last_synced_at: string | null;
  updated_at: string;
  source: string;
}

interface UserRow extends Row {
  id: string;
  email: string;
  university_id: string | null;
  external_provider: string | null;
  external_id: string | null;
  role: string;
  status: string;
}

interface CourseAssignmentRow extends Row {
  id: string;
  course_id: string;
  user_id: string;
  role: string;
  source: string;
  external_provider: string | null;
  external_id: string | null;
  status: string;
}

function emptySummary(): LmsSyncSummary {
  return {
    courses_created: 0,
    courses_updated: 0,
    courses_unchanged: 0,
    students_created: 0,
    students_matched: 0,
    students_invited: 0,
    enrollments_created: 0,
    enrollments_updated: 0,
    enrollments_unchanged: 0,
    enrollments_dropped: 0,
  };
}

/** Entry point. Drives the full course-by-course reconciliation pass
 *  for one sync run. Returns once every course has been processed (or
 *  the listMyCourses call itself failed). The route layer is
 *  responsible for persisting the result into `lms_sync_runs`. */
export async function runLmsReconciliation(
  deps: ReconciliationDeps,
  input: ReconciliationInput,
): Promise<ReconciliationResult> {
  const { db, provider } = deps;
  const summary = emptySummary();
  const errors: LmsSyncError[] = [];
  const conflicts: LmsSyncConflict[] = [];
  const universityId = input.connection.university_id;
  const providerId = input.connection.provider_id;

  await writeAuditLog(db, {
    action: "lms.sync.started",
    actorUserId: input.actorUserId,
    universityId,
    entityType: "lms_sync_run",
    entityId: input.syncRunId,
    metadata: {
      connection_id: input.connection.id,
      provider_id: providerId,
      term_id: input.termId,
      term_name: input.termName,
    },
  });

  await emit(input.onProgress, {
    current_step: 1,
    total_steps: 4,
    label: "Listing courses",
  });

  let courses: LmsCourse[];
  try {
    courses = await provider.listMyCourses(input.connection, input.termId);
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "listMyCourses failed";
    errors.push({ scope: "connection", message });
    await writeAuditLog(db, {
      action: "lms.sync.failed",
      actorUserId: input.actorUserId,
      universityId,
      entityType: "lms_sync_run",
      entityId: input.syncRunId,
      metadata: {
        connection_id: input.connection.id,
        provider_id: providerId,
        reason: message,
        stage: "list_courses",
      },
    });
    return { status: "failed", summary, errors, conflicts };
  }

  let coursesProcessed = 0;
  let coursesSucceeded = 0;
  for (const course of courses) {
    coursesProcessed += 1;
    await emit(input.onProgress, {
      current_step: 2,
      total_steps: 4,
      label: `Reconciling ${coursesProcessed}/${courses.length}: ${course.name}`,
    });
    try {
      await processCourse({
        db,
        provider,
        course,
        input,
        summary,
        errors,
        conflicts,
        universityId,
        providerId,
      });
      coursesSucceeded += 1;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "course reconciliation failed";
      errors.push({
        scope: "course",
        external_id: course.external_id,
        message,
      });
      console.error("lms_reconcile_course_failed", {
        sync_run_id: input.syncRunId,
        course_external_id: course.external_id,
        cause,
      });
    }
  }

  await emit(input.onProgress, {
    current_step: 3,
    total_steps: 4,
    label: "Finalising sync",
  });

  let status: ReconciliationResult["status"];
  if (errors.length === 0) {
    status = "success";
  } else if (coursesSucceeded > 0) {
    status = "partial";
  } else {
    status = "failed";
  }

  await writeAuditLog(db, {
    action: status === "failed" ? "lms.sync.failed" : "lms.sync.completed",
    actorUserId: input.actorUserId,
    universityId,
    entityType: "lms_sync_run",
    entityId: input.syncRunId,
    metadata: {
      connection_id: input.connection.id,
      provider_id: providerId,
      term_id: input.termId,
      term_name: input.termName,
      summary,
      errors_count: errors.length,
      conflicts_count: conflicts.length,
      status,
    },
  });

  await emit(input.onProgress, {
    current_step: 4,
    total_steps: 4,
    label: "Done",
  });

  return { status, summary, errors, conflicts };
}

async function emit(
  cb: ReconciliationInput["onProgress"],
  progress: LmsSyncRunProgress,
): Promise<void> {
  if (!cb) return;
  try {
    await cb(progress);
  } catch (cause) {
    console.warn("lms_progress_emit_failed", { cause });
  }
}

interface CourseProcessingArgs {
  db: D1Database;
  provider: LmsProvider;
  course: LmsCourse;
  input: ReconciliationInput;
  summary: LmsSyncSummary;
  errors: LmsSyncError[];
  conflicts: LmsSyncConflict[];
  universityId: string;
  providerId: LmsProviderId;
}

async function processCourse(args: CourseProcessingArgs): Promise<void> {
  const {
    db,
    provider,
    course,
    input,
    summary,
    errors,
    conflicts,
    universityId,
    providerId,
  } = args;

  const now = new Date().toISOString();

  // 1. Match the course on (external_provider, external_id) within the
  //    caller's university. The lookup is intentionally tenant-scoped
  //    so two universities sharing a Canvas instance can't collide on
  //    a course id namespace.
  const existing = await queryFirst<CourseRow>(
    db,
    `SELECT id, university_id, external_provider, external_id,
            last_synced_at, updated_at, source
       FROM courses
      WHERE university_id = ? AND external_provider = ? AND external_id = ?
      LIMIT 1`,
    [universityId, providerId, course.external_id],
  );

  // Detect conflicts before any write so a manual edit warning fires
  // even when the run later fails on enrollments. The conflict tag is
  // recorded against the LMS course id, not the Hub row id.
  if (
    existing &&
    existing.last_synced_at &&
    existing.updated_at > existing.last_synced_at
  ) {
    conflicts.push({
      course_external_id: course.external_id,
      course_name: course.name,
      reason: "manual_edit_overwritten",
    });
  }

  // 2. List enrollments BEFORE writing the course row. Per the issue's
  //    atomicity requirement ("Each course is processed in one D1
  //    transaction so partial failures don't leave inconsistent
  //    assignments"), a network failure on the enrollments call must
  //    leave the course row unchanged on the next sync. Workers D1
  //    does not expose interactive transactions; reading-then-writing
  //    in this order is the closest functional equivalent.
  const enrollments = await provider.listEnrollments(
    input.connection,
    course.external_id,
  );

  let courseId: string;
  let courseAction: "imported" | "updated" | "unchanged";
  if (existing) {
    await execute(
      db,
      `UPDATE courses
          SET name = ?, code = ?, description = ?,
              external_term_id = ?, last_synced_at = ?, updated_at = ?,
              source = 'lms'
        WHERE id = ?`,
      [
        course.name,
        course.code ?? null,
        course.description ?? null,
        course.external_term_id ?? null,
        now,
        now,
        existing.id,
      ],
    );
    courseId = existing.id;
    courseAction = "updated";
    summary.courses_updated += 1;
  } else {
    courseId = crypto.randomUUID();
    await execute(
      db,
      `INSERT INTO courses
         (id, university_id, department_id, name, code, description, status,
          external_provider, external_id, external_term_id,
          last_synced_at, source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'active', ?, ?, ?, ?, 'lms', ?, ?)`,
      [
        courseId,
        universityId,
        course.name,
        course.code ?? null,
        course.description ?? null,
        providerId,
        course.external_id,
        course.external_term_id ?? null,
        now,
        now,
        now,
      ],
    );
    courseAction = "imported";
    summary.courses_created += 1;
  }

  await writeAuditLog(db, {
    action:
      courseAction === "imported"
        ? "lms.sync.course.imported"
        : "lms.sync.course.updated",
    actorUserId: input.actorUserId,
    universityId,
    entityType: "course",
    entityId: courseId,
    metadata: {
      sync_run_id: input.syncRunId,
      external_provider: providerId,
      external_id: course.external_id,
      course_name: course.name,
    },
  });

  // 3. Track which assignment keys we touched so the soft-delete pass
  //    knows which existing LMS-sourced rows are still in the roster.
  const seenAssignments = new Set<string>();

  for (const enr of enrollments) {
    try {
      await processEnrollment({
        db,
        course,
        courseId,
        enrollment: enr,
        input,
        summary,
        seenAssignments,
        universityId,
        providerId,
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "enrollment reconciliation failed";
      errors.push({
        scope: "enrollment",
        external_id: enr.external_id ?? enr.external_user_id,
        message,
      });
      console.error("lms_reconcile_enrollment_failed", {
        sync_run_id: input.syncRunId,
        course_external_id: course.external_id,
        enrollment_external_id: enr.external_id,
        cause,
      });
    }
  }

  // 4. Soft-delete drops. Anything LMS-sourced for this course/provider
  //    that we didn't touch in this pass and is still 'active' becomes
  //    'dropped'. Manual rows (source = 'manual') are explicitly left
  //    alone — they don't belong to the LMS sync.
  const liveAssignments = await queryAll<CourseAssignmentRow>(
    db,
    `SELECT id, course_id, user_id, role, source,
            external_provider, external_id, status
       FROM course_assignments
      WHERE course_id = ?
        AND source = 'lms'
        AND external_provider = ?
        AND status = 'active'`,
    [courseId, providerId],
  );
  for (const a of liveAssignments) {
    const key = assignmentKey(a.external_id, a.user_id, a.role);
    if (seenAssignments.has(key)) continue;
    await execute(
      db,
      `UPDATE course_assignments
          SET status = 'dropped', last_synced_at = ?, updated_at = ?
        WHERE id = ?`,
      [now, now, a.id],
    );
    summary.enrollments_dropped += 1;
    await writeAuditLog(db, {
      action: "lms.sync.enrollment.dropped",
      actorUserId: input.actorUserId,
      universityId,
      entityType: "course_assignment",
      entityId: a.id,
      metadata: {
        sync_run_id: input.syncRunId,
        course_id: courseId,
        course_external_id: course.external_id,
        user_id: a.user_id,
        role: a.role,
        external_id: a.external_id,
      },
    });
  }
}

interface EnrollmentProcessingArgs {
  db: D1Database;
  course: LmsCourse;
  courseId: string;
  enrollment: LmsEnrollment;
  input: ReconciliationInput;
  summary: LmsSyncSummary;
  seenAssignments: Set<string>;
  universityId: string;
  providerId: LmsProviderId;
}

async function processEnrollment(args: EnrollmentProcessingArgs): Promise<void> {
  const {
    db,
    course,
    courseId,
    enrollment,
    input,
    summary,
    seenAssignments,
    universityId,
    providerId,
  } = args;

  const now = new Date().toISOString();
  const isStudent = enrollment.role === "student";
  const email = enrollment.email ? enrollment.email.toLowerCase() : null;
  const externalUserId = enrollment.external_user_id;

  // 1. Match by external linkage first.
  let userRow: UserRow | null = null;
  if (externalUserId) {
    userRow = await queryFirst<UserRow>(
      db,
      `SELECT id, email, university_id, external_provider, external_id, role, status
         FROM users
        WHERE university_id = ? AND external_provider = ? AND external_id = ?
        LIMIT 1`,
      [universityId, providerId, externalUserId],
    );
  }

  // 2. Fall back to email + university_id.
  let matchedByEmail = false;
  if (!userRow && email) {
    userRow = await queryFirst<UserRow>(
      db,
      `SELECT id, email, university_id, external_provider, external_id, role, status
         FROM users
        WHERE university_id = ? AND lower(email) = ?
        LIMIT 1`,
      [universityId, email],
    );
    if (userRow) matchedByEmail = true;
  }

  // 3. No match → student-only auto-create. Faculty / TA enrollments
  //    that don't resolve to an existing Hub user are recorded as a
  //    per-row error and skipped — auto-creating staff accounts is
  //    explicitly out of scope per the epic's locked decisions.
  if (!userRow) {
    if (isStudent && email) {
      const newUserId = crypto.randomUUID();
      const studentName = enrollment.name ?? email;
      await execute(
        db,
        `INSERT INTO users
           (id, email, password_hash, name, role, status, university_id,
            external_provider, external_id,
            last_sign_in_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'student', 'pending', ?, ?, ?, NULL, ?, ?)`,
        [
          newUserId,
          email,
          LMS_PENDING_PASSWORD_HASH,
          studentName,
          universityId,
          providerId,
          externalUserId,
          now,
          now,
        ],
      );
      const studentId = crypto.randomUUID();
      await execute(
        db,
        `INSERT INTO students
           (id, user_id, university_id, department_id, student_number,
            external_provider, external_id, last_synced_at,
            created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        [
          studentId,
          newUserId,
          universityId,
          providerId,
          externalUserId,
          now,
          now,
          now,
        ],
      );

      // FERPA §99.32 record-of-disclosure. Basis is the §99.31(a)(1)
      // school-official exception — no per-student consent exists or
      // is required for this disclosure (the institution discloses
      // its own enrollment record into its own platform).
      await execute(
        db,
        `INSERT INTO disclosure_log
           (id, student_user_id, university_id, consent_id, basis,
            released_to, data_categories, notes, released_at, released_by_user_id)
         VALUES (?, ?, ?, NULL, 'school_official_exception',
                 ?, ?, ?, ?, NULL)`,
        [
          crypto.randomUUID(),
          newUserId,
          universityId,
          `${providerName(providerId)} sync — University Hub`,
          JSON.stringify(DEFAULT_DISCLOSURE_CATEGORIES),
          `Synced from ${providerName(providerId)} via connection ${input.connection.id} during sync_run ${input.syncRunId}`,
          now,
        ],
      );

      summary.students_created += 1;
      await writeAuditLog(db, {
        action: "lms.sync.student.imported",
        actorUserId: input.actorUserId,
        universityId,
        entityType: "user",
        entityId: newUserId,
        metadata: {
          sync_run_id: input.syncRunId,
          course_id: courseId,
          course_external_id: course.external_id,
          email,
          external_provider: providerId,
          external_id: externalUserId,
        },
      });

      // Loop variable for the assignment block below.
      userRow = {
        id: newUserId,
        email,
        university_id: universityId,
        external_provider: providerId,
        external_id: externalUserId,
        role: "student",
        status: "pending",
      };
    } else {
      throw new Error(
        `no_hub_user_for_${enrollment.role}: faculty/TA enrollments require an existing Hub user (email=${email ?? "null"})`,
      );
    }
  } else if (matchedByEmail && isStudent) {
    // 4. Student matched by email — record the match and backfill the
    //    external linkage on `users` so the next sync hits the fast
    //    path. Don't touch existing external_provider/_id (a user
    //    might already be linked to a different provider).
    if (!userRow.external_provider || !userRow.external_id) {
      await execute(
        db,
        `UPDATE users
            SET external_provider = ?, external_id = ?, updated_at = ?
          WHERE id = ?
            AND external_provider IS NULL
            AND external_id IS NULL`,
        [providerId, externalUserId, now, userRow.id],
      );
    }
    summary.students_matched += 1;
    await writeAuditLog(db, {
      action: "lms.sync.student.matched",
      actorUserId: input.actorUserId,
      universityId,
      entityType: "user",
      entityId: userRow.id,
      metadata: {
        sync_run_id: input.syncRunId,
        course_id: courseId,
        course_external_id: course.external_id,
        email,
        external_provider: providerId,
        external_id: externalUserId,
      },
    });
  }

  // 5. Upsert the course_assignments row. The UNIQUE on (course, user,
  //    role) ensures we never duplicate; we either reactivate a prior
  //    'dropped' row, no-op an already-active row, or insert fresh.
  const role = enrollment.role;
  const existingAssignment = await queryFirst<CourseAssignmentRow>(
    db,
    `SELECT id, course_id, user_id, role, source,
            external_provider, external_id, status
       FROM course_assignments
      WHERE course_id = ? AND user_id = ? AND role = ?
      LIMIT 1`,
    [courseId, userRow.id, role],
  );

  if (existingAssignment) {
    await execute(
      db,
      `UPDATE course_assignments
          SET status = 'active', source = 'lms',
              external_provider = ?, external_id = ?,
              last_synced_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        providerId,
        enrollment.external_id ?? null,
        now,
        now,
        existingAssignment.id,
      ],
    );
    if (
      existingAssignment.status === "active" &&
      existingAssignment.source === "lms" &&
      existingAssignment.external_id === (enrollment.external_id ?? null)
    ) {
      summary.enrollments_unchanged += 1;
    } else {
      summary.enrollments_updated += 1;
    }
    seenAssignments.add(
      assignmentKey(
        enrollment.external_id ?? existingAssignment.external_id,
        userRow.id,
        role,
      ),
    );
  } else {
    const assignmentId = crypto.randomUUID();
    await execute(
      db,
      `INSERT INTO course_assignments
         (id, course_id, user_id, role, source,
          external_provider, external_id, last_synced_at, status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'lms', ?, ?, ?, 'active', ?, ?)`,
      [
        assignmentId,
        courseId,
        userRow.id,
        role,
        providerId,
        enrollment.external_id ?? null,
        now,
        now,
        now,
      ],
    );
    summary.enrollments_created += 1;
    seenAssignments.add(
      assignmentKey(enrollment.external_id ?? null, userRow.id, role),
    );
    await writeAuditLog(db, {
      action: "lms.sync.enrollment.imported",
      actorUserId: input.actorUserId,
      universityId,
      entityType: "course_assignment",
      entityId: assignmentId,
      metadata: {
        sync_run_id: input.syncRunId,
        course_id: courseId,
        course_external_id: course.external_id,
        user_id: userRow.id,
        role,
        external_id: enrollment.external_id ?? null,
      },
    });
  }
}

function assignmentKey(
  externalId: string | null,
  userId: string,
  role: string,
): string {
  // Prefer the provider-supplied enrollment id when available — it is
  // the strongest dedup key. Fall back to the (user, role) pair when
  // the provider doesn't expose a stable id.
  return externalId ? `ext:${externalId}` : `pair:${userId}:${role}`;
}

function providerName(id: LmsProviderId): string {
  switch (id) {
    case "canvas":
      return "Canvas";
    case "blackboard":
      return "Blackboard";
    case "moodle":
      return "Moodle";
    case "google_classroom":
      return "Google Classroom";
  }
}
