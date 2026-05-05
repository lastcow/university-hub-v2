import { z } from "zod";

import { passwordSchema } from "./common.js";

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(120, "Name is too long");

const universityNameSchema = z
  .string()
  .trim()
  .min(2, "University name is required")
  .max(120, "University name is too long");

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Slug may only contain lowercase letters, numbers, and dashes",
  )
  .min(2, "Slug is too short")
  .max(60, "Slug is too long");

// PATCH /api/settings/university — RBAC gated to super_admin / university_admin
// of the actor's own university. Slug is nullable so admins can clear it.
export const updateSettingsUniversityInputSchema = z
  .object({
    name: universityNameSchema.optional(),
    slug: slugSchema.nullable().optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.slug !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateSettingsUniversityInput = z.infer<
  typeof updateSettingsUniversityInputSchema
>;

// PATCH /api/settings/account — current user's own profile + optional password
// change. Both `current_password` and `new_password` must be supplied together.
// Either the name change or the password change must be present.
export const updateSettingsAccountInputSchema = z
  .object({
    name: nameSchema.optional(),
    current_password: z.string().min(1).optional(),
    new_password: passwordSchema.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      (data.current_password !== undefined && data.new_password !== undefined),
    { message: "At least one field is required" },
  )
  .refine(
    (data) =>
      (data.current_password === undefined &&
        data.new_password === undefined) ||
      (data.current_password !== undefined && data.new_password !== undefined),
    {
      message:
        "Both current_password and new_password are required to change password",
      path: ["new_password"],
    },
  );
export type UpdateSettingsAccountInput = z.infer<
  typeof updateSettingsAccountInputSchema
>;

// PATCH /api/settings/system — super_admin-only scalars (UNI-47).
//
// `mfa_trusted_device_days`: rolling window for the "Remember this device"
// MFA bypass for `university_admin`. Bounded 1..90 to prevent both an
// always-on bypass (window=0 disables; documented as a server-side
// minimum of 1 day) and a runaway "trust forever" misconfiguration.
export const updateSystemSettingsInputSchema = z
  .object({
    mfa_trusted_device_days: z
      .number()
      .int("Days must be a whole number")
      .min(1, "Days must be at least 1")
      .max(90, "Days must be at most 90")
      .optional(),
  })
  .refine((data) => data.mfa_trusted_device_days !== undefined, {
    message: "At least one field is required",
  });
export type UpdateSystemSettingsInput = z.infer<
  typeof updateSystemSettingsInputSchema
>;
