import { z } from "zod";

import { roleSchema, userStatusSchema } from "./common.js";

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(120, "Name is too long");

export const updateUserProfileInputSchema = z
  .object({
    name: nameSchema.optional(),
  })
  .refine((data) => data.name !== undefined, {
    message: "At least one field is required",
  });
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileInputSchema>;

export const updateUserRoleInputSchema = z.object({
  role: roleSchema,
});
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleInputSchema>;

// Status changes are limited to active / inactive / suspended (`pending` is the
// state for users who haven't yet accepted an invitation, and is set by the
// invitation flow — admins shouldn't toggle a user back into pending).
export const updateUserStatusInputSchema = z.object({
  status: z.enum(["active", "inactive", "suspended"] as const),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusInputSchema>;

// Re-export userStatusSchema so consumers don't need both barrels.
export { userStatusSchema };
