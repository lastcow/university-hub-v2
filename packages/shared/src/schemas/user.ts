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
// invitation flow — admins shouldn't toggle a user back into pending; `deleted`
// is set by the dedicated `DELETE /api/users/:id` endpoint, never by this PATCH).
export const updateUserStatusInputSchema = z.object({
  status: z.enum(["active", "inactive", "suspended"] as const),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusInputSchema>;

// `DELETE /api/users/:id` body. Optional reason is captured in the
// `user.deleted` audit log entry alongside actor + role_before metadata so
// downstream review can see *why* a removal happened. We cap the length so
// nothing overlong reaches the audit row (which is read by an admin UI).
export const deleteUserInputSchema = z.object({
  reason: z.string().trim().max(500, "Reason is too long").optional(),
});
export type DeleteUserInput = z.infer<typeof deleteUserInputSchema>;

// Re-export userStatusSchema so consumers don't need both barrels.
export { userStatusSchema };
