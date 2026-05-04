// Privacy policy + ToS surfaces (epic UNI-21 / sub-issue UNI-34).
//
// `LegalDocument` is the current customer-visible content for a kind
// (`terms` | `privacy`) — body markdown plus a monotonically increasing
// version. Bumping the version forces a re-acceptance gate on the next
// authenticated app load.
//
// `LegalAcknowledgmentStatus` is what the in-app gate reads on every
// app-shell mount: did the signed-in user accept the *current* version?
// If not (or never), the SPA blocks on a re-acceptance modal.
//
// Public-page reads are anonymous; the worker resolves the right document
// by `university_id` (per-customer override) and falls back to the global
// default when no override is configured. The frontend never sees the
// raw row id — all reads are by kind + (optional) university scope.

import type { Id, IsoDateString } from "./common.js";

export const LEGAL_DOCUMENT_KINDS = ["terms", "privacy"] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

export const LEGAL_DOCUMENT_KIND_LABELS: Record<LegalDocumentKind, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
};

/**
 * Public-shape document. The body is rendered into a small markdown
 * subset (headings, paragraphs, lists, links, emphasis) on both the
 * marketing pages and the in-app modals.
 */
export interface LegalDocument {
  kind: LegalDocumentKind;
  version: number;
  body_md: string;
  published_at: IsoDateString;
  university_id: Id | null;
  university_name: string | null;
  /** Source of the body — `customer` if the university has overridden the
   *  default, `default` if we're serving the global boilerplate. */
  source: "customer" | "default";
}

/**
 * Result of `GET /api/legal/admin` — the two current documents (terms +
 * privacy) for the actor's university. Includes the body so the admin
 * Legal tab can display + edit. `is_overridden` distinguishes "this
 * customer has saved their own copy" from "we're showing the default".
 */
export interface LegalAdminDocument extends LegalDocument {
  /** Customer override exists in `legal_documents` for this (uni, kind)? */
  is_overridden: boolean;
  updated_by_user_id: Id | null;
  updated_by_name: string | null;
  updated_at: IsoDateString;
}

export interface LegalAdminResponse {
  university_id: Id | null;
  university_name: string | null;
  contact_email: string | null;
  documents: {
    terms: LegalAdminDocument;
    privacy: LegalAdminDocument;
  };
}

/**
 * Read by the SPA on every app-shell mount. When `terms_required` is
 * true, the SPA blocks on a re-acceptance modal until the user POSTs
 * `/api/legal/accept`.
 */
export interface LegalAcknowledgmentStatus {
  terms_required: boolean;
  current_terms_version: number;
  current_privacy_version: number;
  accepted_terms_version: number | null;
  accepted_at: IsoDateString | null;
  university_id: Id | null;
  university_name: string | null;
  contact_email: string | null;
}

export interface LegalAcceptResponse {
  accepted_terms_version: number;
  accepted_privacy_version: number;
  accepted_at: IsoDateString;
}
