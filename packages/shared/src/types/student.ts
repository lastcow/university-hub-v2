import type { Id, IsoDateString } from "./common.js";

export interface Student {
  id: Id;
  user_id: Id;
  university_id: Id;
  department_id: Id | null;
  student_number: string | null;
  /** FERPA directory-information opt-out (epic UNI-21 / sub-issue UNI-32). */
  directory_info_opt_out: boolean;
  /** Drives the parent / guardian sign-in flow. */
  under_18: boolean;
  /**
   * Parent / guardian email used by the parent token sign-in path. Always
   * NULL when `under_18` is false (we don't need it once the student turns
   * 18 — FERPA rights transfer to them).
   */
  parent_guardian_email: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** `Student` row joined with the underlying user + university/department names. */
export interface StudentListItem extends Student {
  name: string;
  email: string;
  university_name: string | null;
  department_name: string | null;
}
