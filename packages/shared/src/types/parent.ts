// Parent / guardian passwordless sign-in surface (epic UNI-21 / sub-issue
// UNI-32). The parent has no `users` row and no role — they just hold a
// short-lived session bound to one student, established via an emailed
// token. See migration 0008_ferpa_controls.sql for the data model.

import type { Id, IsoDateString } from "./common.js";

/**
 * Response for `POST /api/parent/sign-in/request`. Always 202 with the same
 * generic body regardless of whether the email matches an under-18 student
 * — institutions cannot leak which kids the system knows about.
 */
export interface ParentSignInRequestResponse {
  ok: true;
  message: string;
}

export interface ParentSignInVerifyResponse {
  ok: true;
  parent: ParentMe;
}

export interface ParentMe {
  parent_email: string;
  /** Always set — a parent session is bound to exactly one student. */
  student: ParentStudentSummary;
  expires_at: IsoDateString;
}

export interface ParentStudentSummary {
  student_id: Id;
  student_user_id: Id;
  name: string;
  email: string;
  university_id: Id | null;
  university_name: string | null;
}
