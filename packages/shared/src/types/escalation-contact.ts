// Escalation-contact surface (epic UNI-21 / sub-issue UNI-40).
//
// Six fixed role slots, one row per slot in `escalation_contacts`. Operators
// edit names / emails / phones / notes from a super_admin-only Settings card;
// the breach-response runbook (`docs/incident-response.md`) treats the in-app
// table as the source of truth.
//
// Single-tenant per deploy: there is exactly one row per `role_key` per
// deploy — no `university_id` scoping.

import type { Id, IsoDateString } from "./common.js";

export const ESCALATION_CONTACT_ROLE_KEYS = [
  "operator_oncall",
  "customer_dpo",
  "customer_ferpa_officer",
  "customer_it_lead",
  "customer_general_counsel",
  "customer_ceo",
] as const;

export type EscalationContactRoleKey =
  (typeof ESCALATION_CONTACT_ROLE_KEYS)[number];

export const ESCALATION_CONTACT_ROLE_LABELS: Record<
  EscalationContactRoleKey,
  string
> = {
  operator_oncall: "SaaS operator on-call lead",
  customer_dpo: "Customer DPO / privacy officer",
  customer_ferpa_officer: "Customer FERPA officer",
  customer_it_lead: "Customer IT / security lead",
  customer_general_counsel: "Customer General Counsel",
  customer_ceo: "Customer CEO / executive sponsor",
};

export interface EscalationContact {
  role_key: EscalationContactRoleKey;
  role_label: string;
  display_order: number;
  person_name: string;
  email: string;
  phone: string;
  notes: string;
  /**
   * True when the row still has its seeded mockup contents (RFC 2606
   * `*@example.*` email domain or the +1-555-01xx fictional phone range).
   * The runbook treats `is_mockup` rows as a launch blocker — same severity
   * as blank placeholders pre-UNI-40.
   */
  is_mockup: boolean;
  updated_by_user_id: Id | null;
  updated_by_name: string | null;
  updated_at: IsoDateString;
}

export interface EscalationContactsResponse {
  contacts: EscalationContact[];
  /** True if any row still carries mockup contents — surfaces the
   *  launch-blocker banner in the admin UI and would promote a
   *  blank-row-equivalent finding to S2 in a real incident. */
  any_mockup: boolean;
}
