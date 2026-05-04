// Escalation-contact zod schemas (epic UNI-21 / sub-issue UNI-40).

import { z } from "zod";

import { ESCALATION_CONTACT_ROLE_KEYS } from "../types/escalation-contact.js";

export const escalationContactRoleKeySchema = z.enum(
  ESCALATION_CONTACT_ROLE_KEYS,
);

const trimmedRequired = (max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} cannot be empty`)
        .max(max, `${label} is too long`),
    );

const trimmedOptional = (max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(max, `${label} is too long`));

/**
 * Admin save for one contact row. Only the contact details and the role
 * label are editable — `role_key` is path-based, `display_order` /
 * `created_at` are immutable.
 */
export const updateEscalationContactInputSchema = z.object({
  role_label: trimmedRequired(120, "Role label"),
  person_name: trimmedRequired(200, "Name"),
  email: trimmedRequired(254, "Email").pipe(
    z.string().email("Invalid email address"),
  ),
  phone: trimmedRequired(64, "Phone"),
  notes: trimmedOptional(1_000, "Notes").default(""),
});

export type UpdateEscalationContactInput = z.infer<
  typeof updateEscalationContactInputSchema
>;
