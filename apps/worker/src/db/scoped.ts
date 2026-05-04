// Per-course query scoping for faculty / teacher / teacher_assistant actors
// (epic UNI-21 / issue UNI-22). The threat model is intra-university,
// cross-course data leakage: a faculty member must not be able to see grades
// or rosters for a course they don't teach. RBAC alone gates by role, not by
// course assignment; this module enforces "assigned to course X in role Y" as
// a query-layer guarantee.
//
// Usage in a handler:
//
//   const actor = toActor(auth.user);
//   const scope = await forCourse(env.DB, courseId, actor);
//   const grades = await scope.queryAll<GradeRow>(
//     `SELECT * FROM grades WHERE assessment_id IN (
//        SELECT id FROM assessments WHERE course_id = ?
//      )`,
//     [scope.courseId],
//   );
//
// `forCourse` throws `CourseScopeError` if the actor is not assigned (or the
// course doesn't exist). Callers in route handlers should translate via
// `courseScopeErrorResponse` so the wire response is a clean 404/403.
//
// Admin bypass: super_admin always passes; university_admin passes when the
// course is in their university. Everyone else must have a row in
// `course_assignments` matching one of the allowed course-roles.
//
// The returned `CourseScope` object is branded — a route handler cannot
// fabricate one without going through this module, and that brand acts as a
// type-level proof that "the actor IS allowed to touch this course". Pass
// `CourseScope` (not raw `D1Database`) into helpers that need that proof.

import type { CourseAssignmentRole, Role } from "@university-hub/shared";

import { execute, queryAll, queryFirst, type ExecMeta, type Row } from "./index.js";

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * Minimal actor surface required to scope a query. Construct via `toActor()`
 * from the resolved session user (`UserRow` in middleware/auth.ts) so the
 * scoping helpers don't have to know about the full user shape.
 *
 * All three fields are required at the type level — omitting any of them is
 * a compile error, which is the point: scoping decisions cannot silently
 * happen without an authenticated actor.
 */
export interface Actor {
  readonly user_id: string;
  readonly role: Role;
  readonly university_id: string | null;
}

/** Build an Actor from a row that has at least these fields. */
export function toActor(user: {
  id: string;
  role: Role;
  university_id: string | null;
}): Actor {
  return {
    user_id: user.id,
    role: user.role,
    university_id: user.university_id,
  };
}

// ---------------------------------------------------------------------------
// Roles that need per-course scoping
// ---------------------------------------------------------------------------

/**
 * Roles whose access to a given course is mediated by `course_assignments`.
 * Admins (super / university_admin) bypass this check; staff / student / etc.
 * are evaluated by other means at the route layer.
 */
export const COURSE_SCOPED_ROLES: readonly Role[] = [
  "faculty",
  "teacher",
  "teacher_assistant",
];

/**
 * Default `course_assignments.role` set the helpers accept when a caller
 * doesn't pass `allowedCourseRoles` — i.e. "any of the teaching roles."
 */
export const DEFAULT_ALLOWED_COURSE_ROLES: readonly CourseAssignmentRole[] = [
  "faculty",
  "teacher",
  "teacher_assistant",
];

export function isCourseScopedRole(role: Role): boolean {
  return COURSE_SCOPED_ROLES.includes(role);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CourseScopeReason =
  | "course_not_found"
  | "course_access_denied";

/**
 * Thrown when an actor is not allowed on a course. Two failure modes:
 *
 *   - `course_not_found` — the course id doesn't resolve. We use 404 (not
 *     403) so an unauthorized actor can't probe for course existence.
 *   - `course_access_denied` — the course exists but the actor is in a role
 *     that requires an assignment, and they don't have one (or not in an
 *     allowed role). The route layer typically maps this to 404 too, for the
 *     same reason; pass `as: "forbidden"` to courseScopeErrorResponse if a
 *     caller has a reason to surface 403 (e.g. write endpoints where the
 *     actor already has read access via another path).
 */
export class CourseScopeError extends Error {
  readonly reason: CourseScopeReason;
  readonly courseId: string;
  readonly actorId: string;

  constructor(reason: CourseScopeReason, courseId: string, actorId: string) {
    super(
      reason === "course_not_found"
        ? `Course ${courseId} not found.`
        : `Actor ${actorId} is not assigned to course ${courseId} in an allowed role.`,
    );
    this.name = "CourseScopeError";
    this.reason = reason;
    this.courseId = courseId;
    this.actorId = actorId;
  }
}

interface CourseRow {
  id: string;
  university_id: string;
}

async function loadCourse(db: D1Database, courseId: string): Promise<CourseRow | null> {
  return queryFirst<CourseRow & Row>(
    db,
    `SELECT id, university_id FROM courses WHERE id = ? LIMIT 1`,
    [courseId],
  );
}

function isAdminBypass(actor: Actor, course: CourseRow): boolean {
  if (actor.role === "super_admin") return true;
  if (
    actor.role === "university_admin" &&
    actor.university_id !== null &&
    actor.university_id === course.university_id
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// assertActorOnCourse — write-side / explicit gate
// ---------------------------------------------------------------------------

export type ResolvedAssignmentRole = CourseAssignmentRole | "admin";

export interface AssertActorOnCourseResult {
  readonly courseId: string;
  readonly universityId: string;
  /** "admin" when super_admin or same-uni university_admin bypassed the check. */
  readonly assignmentRole: ResolvedAssignmentRole;
}

/**
 * Throws `CourseScopeError` if `actor` is not allowed to act on `courseId`
 * in any of `allowedCourseRoles` (default: faculty / teacher / TA).
 *
 * Use this at the top of write endpoints (POST / PATCH / DELETE) where you
 * don't need a query builder, just a yes/no decision.
 */
export async function assertActorOnCourse(
  db: D1Database,
  actor: Actor,
  courseId: string,
  allowedCourseRoles: readonly CourseAssignmentRole[] = DEFAULT_ALLOWED_COURSE_ROLES,
): Promise<AssertActorOnCourseResult> {
  const course = await loadCourse(db, courseId);
  if (!course) {
    throw new CourseScopeError("course_not_found", courseId, actor.user_id);
  }

  if (isAdminBypass(actor, course)) {
    return {
      courseId: course.id,
      universityId: course.university_id,
      assignmentRole: "admin",
    };
  }

  // Cross-university actor (incl. university_admin in a different uni) is
  // never allowed onto a course in another uni — fall straight through to the
  // 403 path so we don't even consider their assignments table rows (which
  // shouldn't exist in a clean dataset, but defense in depth).
  if (
    actor.university_id !== null &&
    actor.university_id !== course.university_id
  ) {
    throw new CourseScopeError("course_access_denied", courseId, actor.user_id);
  }

  if (allowedCourseRoles.length === 0) {
    throw new CourseScopeError("course_access_denied", courseId, actor.user_id);
  }

  const placeholders = allowedCourseRoles.map(() => "?").join(",");
  const assignment = await queryFirst<{ role: CourseAssignmentRole } & Row>(
    db,
    `SELECT role FROM course_assignments
       WHERE course_id = ? AND user_id = ? AND role IN (${placeholders})
       LIMIT 1`,
    [courseId, actor.user_id, ...allowedCourseRoles],
  );
  if (!assignment) {
    throw new CourseScopeError("course_access_denied", courseId, actor.user_id);
  }

  return {
    courseId: course.id,
    universityId: course.university_id,
    assignmentRole: assignment.role,
  };
}

// ---------------------------------------------------------------------------
// forCoursesOfActor — list-side
// ---------------------------------------------------------------------------

/**
 * Returns the set of course ids the actor is assigned to in any of the
 * requested course-roles. Use this for "my courses" list endpoints to avoid
 * loading every course in the university and filtering in TypeScript.
 *
 * Admins (super_admin / same-uni university_admin) intentionally do NOT get
 * an automatic "every course" expansion — admin handlers should query the
 * `courses` table directly with their own scoping (university_id), since the
 * concept "courses I'm assigned to" doesn't apply to them.
 */
export async function forCoursesOfActor(
  db: D1Database,
  actor: Actor,
  role: CourseAssignmentRole | readonly CourseAssignmentRole[],
): Promise<string[]> {
  const roles = Array.isArray(role) ? role : [role as CourseAssignmentRole];
  if (roles.length === 0) return [];

  const placeholders = roles.map(() => "?").join(",");
  const rows = await queryAll<{ course_id: string } & Row>(
    db,
    `SELECT DISTINCT course_id FROM course_assignments
       WHERE user_id = ? AND role IN (${placeholders})`,
    [actor.user_id, ...roles],
  );
  return rows.map((r) => r.course_id);
}

// ---------------------------------------------------------------------------
// forCourse — read-side scoped query builder
// ---------------------------------------------------------------------------

/**
 * Brand symbol so route handlers can't construct a `CourseScope` without
 * going through `forCourse(...)`. The brand has no runtime effect; it makes
 * "I have a CourseScope" a type-level proof that the helper has already
 * verified the actor's assignment for this course.
 *
 * Convention (not enforced by the compiler): handlers that need course-
 * scoped data should accept a `CourseScope`, not a raw `D1Database`, and
 * should run their queries via `scope.queryAll/.queryFirst/.execute` rather
 * than `env.DB.prepare(...)`. A future ESLint rule can flag the latter in
 * grades / analytics modules.
 */
declare const courseScopeBrand: unique symbol;

export interface CourseScope {
  readonly [courseScopeBrand]: never;
  readonly courseId: string;
  readonly universityId: string;
  readonly actor: Actor;
  readonly assignmentRole: ResolvedAssignmentRole;

  queryAll<T extends Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  queryFirst<T extends Row>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  execute(sql: string, params?: readonly unknown[]): Promise<ExecMeta>;
}

class CourseScopeImpl implements CourseScope {
  // Brand existence is purely structural; runtime value is irrelevant.
  declare readonly [courseScopeBrand]: never;

  constructor(
    private readonly db: D1Database,
    readonly courseId: string,
    readonly universityId: string,
    readonly actor: Actor,
    readonly assignmentRole: ResolvedAssignmentRole,
  ) {}

  queryAll<T extends Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return queryAll<T>(this.db, sql, params);
  }

  queryFirst<T extends Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    return queryFirst<T>(this.db, sql, params);
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<ExecMeta> {
    return execute(this.db, sql, params);
  }
}

/**
 * Verifies the actor is assigned to `courseId` in one of `allowedCourseRoles`
 * (default: faculty / teacher / TA), then returns a branded `CourseScope`
 * carrying the course id + actor + resolved assignment role.
 *
 * Throws `CourseScopeError` on failure — translate to a Response in handlers
 * via `courseScopeErrorResponse`.
 */
export async function forCourse(
  db: D1Database,
  courseId: string,
  actor: Actor,
  allowedCourseRoles: readonly CourseAssignmentRole[] = DEFAULT_ALLOWED_COURSE_ROLES,
): Promise<CourseScope> {
  const result = await assertActorOnCourse(db, actor, courseId, allowedCourseRoles);
  return new CourseScopeImpl(
    db,
    result.courseId,
    result.universityId,
    actor,
    result.assignmentRole,
  );
}

// ---------------------------------------------------------------------------
// Response translation helper
// ---------------------------------------------------------------------------

interface ApiErrorBody {
  ok: false;
  error: {
    status: number;
    code: string;
    message: string;
  };
}

/**
 * Maps a `CourseScopeError` to an HTTP response. Defaults to 404 in both
 * cases (probe-resistance). Pass `as: "forbidden"` from a write endpoint
 * where the actor demonstrably already has read access — surfacing 403
 * there is more honest and won't leak existence.
 */
export function courseScopeErrorResponse(
  err: CourseScopeError,
  opts: { as?: "not_found" | "forbidden" } = {},
): Response {
  const wantsForbidden =
    opts.as === "forbidden" && err.reason === "course_access_denied";
  const status = wantsForbidden ? 403 : 404;
  const code = wantsForbidden ? "forbidden" : "not_found";
  const message = wantsForbidden
    ? "You do not have access to this course."
    : "Course not found.";
  const body: ApiErrorBody = {
    ok: false,
    error: { status, code, message },
  };
  return Response.json(body, { status });
}
