// FERPA disclosure controls (epic UNI-21 / sub-issue UNI-32).
//
// `DisclosureConsent` is FERPA §99.30 written consent — granter, requester,
// purpose, categories of data covered. Revocation is recorded in place via
// `revoked_at`.
//
// `DisclosureLog` is FERPA §99.32 record of disclosure — every actual
// release, referencing the consent that authorized it.

import type { Id, IsoDateString } from "./common.js";

export const DISCLOSURE_DATA_CATEGORIES = [
  "grades",
  "transcript",
  "attendance",
  "disciplinary",
  "directory",
  "financial_aid",
  "other",
] as const;

export type DisclosureDataCategory =
  (typeof DISCLOSURE_DATA_CATEGORIES)[number];

export const DISCLOSURE_DATA_CATEGORY_LABELS: Record<
  DisclosureDataCategory,
  string
> = {
  grades: "Grades",
  transcript: "Transcript",
  attendance: "Attendance",
  disciplinary: "Disciplinary records",
  directory: "Directory information",
  financial_aid: "Financial aid",
  other: "Other",
};

export interface DisclosureConsent {
  id: Id;
  student_user_id: Id;
  university_id: Id | null;
  requester: string;
  purpose: string;
  data_categories: DisclosureDataCategory[];
  granted_at: IsoDateString;
  granted_by_user_id: Id | null;
  expires_at: IsoDateString | null;
  revoked_at: IsoDateString | null;
  revoked_by_user_id: Id | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

export interface DisclosureConsentListItem extends DisclosureConsent {
  student_name: string | null;
  student_email: string | null;
  granted_by_name: string | null;
  /** Convenience flag — `revoked_at !== null || (expires_at && expires_at < now)`. */
  active: boolean;
}

/** Legal basis for a disclosure under FERPA. Defaults to `'consent'` for
 *  any §99.30-style written consent — the original UNI-32 surface. The
 *  LMS reconciliation engine (UNI-56) records system-attributed
 *  disclosures under `'school_official_exception'` (§99.31(a)(1)),
 *  which does not require a per-student consent and therefore leaves
 *  `consent_id` null. The schema enforces the invariant that
 *  `basis === 'consent' ⇔ consent_id IS NOT NULL`. */
export type DisclosureBasis =
  | "consent"
  | "school_official_exception"
  | "directory_info"
  | "judicial_order"
  | "other";

export interface DisclosureLogEntry {
  id: Id;
  student_user_id: Id;
  university_id: Id | null;
  /** Null when `basis !== 'consent'` — non-consent disclosures (LMS
   *  sync, judicial orders, etc.) cite the relevant FERPA basis
   *  instead of a written consent. */
  consent_id: Id | null;
  basis: DisclosureBasis;
  released_to: string;
  data_categories: DisclosureDataCategory[];
  notes: string | null;
  released_at: IsoDateString;
  released_by_user_id: Id | null;
}

export interface DisclosureLogListItem extends DisclosureLogEntry {
  student_name: string | null;
  student_email: string | null;
  released_by_name: string | null;
  consent_requester: string | null;
  consent_purpose: string | null;
}

export interface DisclosureLogListResponse {
  items: DisclosureLogListItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
