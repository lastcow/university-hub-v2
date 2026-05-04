import { z } from "zod";

import {
  courseAssignmentRoleSchema,
  courseStatusSchema,
  idSchema,
} from "./common.js";

const nameSchema = z
  .string()
  .trim()
  .min(2, "Course name is required")
  .max(160, "Course name is too long");

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/,
    "Code may only contain letters, numbers, spaces, and dashes",
  )
  .min(2, "Code is too short")
  .max(32, "Code is too long");

const descriptionSchema = z
  .string()
  .trim()
  .max(4000, "Description is too long");

export const createCourseInputSchema = z.object({
  university_id: idSchema.optional(),
  department_id: idSchema.nullable().optional(),
  name: nameSchema,
  code: codeSchema.nullable().optional(),
  description: descriptionSchema.nullable().optional(),
  status: courseStatusSchema.optional(),
});
export type CreateCourseInput = z.infer<typeof createCourseInputSchema>;

export const updateCourseInputSchema = z
  .object({
    department_id: idSchema.nullable().optional(),
    name: nameSchema.optional(),
    code: codeSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    status: courseStatusSchema.optional(),
  })
  .refine(
    (data) =>
      data.department_id !== undefined ||
      data.name !== undefined ||
      data.code !== undefined ||
      data.description !== undefined ||
      data.status !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateCourseInput = z.infer<typeof updateCourseInputSchema>;

export const createCourseAssignmentInputSchema = z.object({
  user_id: idSchema,
  role: courseAssignmentRoleSchema,
});
export type CreateCourseAssignmentInput = z.infer<
  typeof createCourseAssignmentInputSchema
>;
