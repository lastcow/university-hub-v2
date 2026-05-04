// FERPA record-of-access writer (epic UNI-21 / sub-issue UNI-30).
//
// Every read of grade data must write one row to `grade_access_log`. Failures
// are logged but never block the user — the audit_logs writer follows the
// same pattern, and treating the log as advisory keeps a transient D1 hiccup
// from turning into a 500 on a routine gradebook view. The admin record-of-
// access page is the consumer; bulk reads of N students emit N rows so the
// admin filter "who has been seeing student X" works without expanding a
// "course view" entry into rows after the fact.

import type { Role } from "@university-hub/shared";

import { execute } from "../db/index.js";

export type GradeAccessContext =
  | "course_gradebook"
  | "student_self"
  | "student_view_by_faculty";

export interface GradeAccessLogInput {
  viewerUserId: string | null;
  viewerRole: Role;
  viewerCourseRole?: string | null;
  courseId?: string | null;
  assessmentId?: string | null;
  viewedGradeId?: string | null;
  viewedStudentUserId: string | null;
  context: GradeAccessContext;
}

export async function writeGradeAccessLog(
  db: D1Database,
  input: GradeAccessLogInput,
): Promise<void> {
  try {
    await execute(
      db,
      `INSERT INTO grade_access_log
         (id, viewer_user_id, viewer_role, viewer_course_role,
          course_id, assessment_id, viewed_grade_id, viewed_student_user_id,
          context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.viewerUserId ?? null,
        input.viewerRole,
        input.viewerCourseRole ?? null,
        input.courseId ?? null,
        input.assessmentId ?? null,
        input.viewedGradeId ?? null,
        input.viewedStudentUserId ?? null,
        input.context,
      ],
    );
  } catch (cause) {
    console.error("grade_access_log_insert_failed", {
      context: input.context,
      cause,
    });
  }
}

export async function writeGradeAccessLogBatch(
  db: D1Database,
  rows: readonly GradeAccessLogInput[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    await writeGradeAccessLog(db, row);
  }
}
