// Privacy policy + ToS schemas (epic UNI-21 / sub-issue UNI-34).

import { z } from "zod";

import { LEGAL_DOCUMENT_KINDS } from "../types/legal.js";

export const legalDocumentKindSchema = z.enum(LEGAL_DOCUMENT_KINDS);

const bodyMdSchema = z
  .string()
  .min(1, "Document body cannot be empty")
  .max(60_000, "Document body is too long");

/**
 * Admin save for a legal document. `version_bump=true` increments the
 * stored version, which forces every user under the same `university_id`
 * to re-acknowledge on next app load. False is for typo fixes that don't
 * warrant interrupting the user base.
 */
export const updateLegalDocumentInputSchema = z.object({
  body_md: bodyMdSchema,
  version_bump: z.boolean().optional().default(false),
});
export type UpdateLegalDocumentInput = z.infer<
  typeof updateLegalDocumentInputSchema
>;

/**
 * Body for the in-app re-acceptance gate POST. The client echoes the
 * version it actually saw so a stale tab can't silently mark a never-
 * displayed version as accepted.
 */
export const acceptLegalInputSchema = z.object({
  terms_version: z.number().int().min(1),
  privacy_version: z.number().int().min(1),
});
export type AcceptLegalInput = z.infer<typeof acceptLegalInputSchema>;
