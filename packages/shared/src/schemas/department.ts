import { z } from "zod";

import { idSchema } from "./common.js";

const nameSchema = z
  .string()
  .trim()
  .min(2, "Department name is required")
  .max(120, "Department name is too long");

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/,
    "Code may only contain letters, numbers, and dashes",
  )
  .min(2, "Code is too short")
  .max(24, "Code is too long");

const descriptionSchema = z
  .string()
  .trim()
  .max(2000, "Description is too long");

export const createDepartmentInputSchema = z.object({
  university_id: idSchema.optional(),
  name: nameSchema,
  code: codeSchema.nullable().optional(),
  description: descriptionSchema.nullable().optional(),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentInputSchema>;

export const updateDepartmentInputSchema = z
  .object({
    name: nameSchema.optional(),
    code: codeSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.code !== undefined ||
      data.description !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentInputSchema>;
