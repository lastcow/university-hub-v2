// FERPA disclosure schemas (epic UNI-21 / sub-issue UNI-32).

import { z } from "zod";

import { DISCLOSURE_DATA_CATEGORIES } from "../types/disclosure.js";

import { emailSchema, idSchema, isoDateStringSchema } from "./common.js";

const requesterSchema = z
  .string()
  .trim()
  .min(2, "Requester is required")
  .max(200, "Requester is too long");

const purposeSchema = z
  .string()
  .trim()
  .min(2, "Purpose is required")
  .max(2000, "Purpose is too long");

const notesSchema = z
  .string()
  .trim()
  .max(2000, "Notes are too long");

const dataCategorySchema = z.enum(DISCLOSURE_DATA_CATEGORIES);

const dataCategoriesSchema = z
  .array(dataCategorySchema)
  .min(1, "Select at least one data category")
  .max(DISCLOSURE_DATA_CATEGORIES.length, "Too many data categories");

export const updateDirectoryInfoInputSchema = z.object({
  directory_info_opt_out: z.boolean(),
});
export type UpdateDirectoryInfoInput = z.infer<
  typeof updateDirectoryInfoInputSchema
>;

export const createDisclosureConsentInputSchema = z.object({
  student_user_id: idSchema,
  requester: requesterSchema,
  purpose: purposeSchema,
  data_categories: dataCategoriesSchema,
  expires_at: isoDateStringSchema.nullable().optional(),
});
export type CreateDisclosureConsentInput = z.infer<
  typeof createDisclosureConsentInputSchema
>;

export const recordDisclosureInputSchema = z.object({
  consent_id: idSchema,
  released_to: requesterSchema,
  data_categories: dataCategoriesSchema,
  notes: notesSchema.nullable().optional(),
});
export type RecordDisclosureInput = z.infer<
  typeof recordDisclosureInputSchema
>;

// ---------------------------------------------------------------------------
// Parent / guardian sign-in
// ---------------------------------------------------------------------------

export const parentSignInRequestInputSchema = z.object({
  parent_email: emailSchema,
});
export type ParentSignInRequestInput = z.infer<
  typeof parentSignInRequestInputSchema
>;

export const parentSignInVerifyInputSchema = z.object({
  parent_email: emailSchema,
  token: z
    .string()
    .trim()
    .min(8, "Token is required")
    .max(200, "Token is too long"),
});
export type ParentSignInVerifyInput = z.infer<
  typeof parentSignInVerifyInputSchema
>;
