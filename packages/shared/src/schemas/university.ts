import { z } from "zod";

import { universityStatusSchema } from "./common.js";

const nameSchema = z
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

export const createUniversityInputSchema = z.object({
  name: nameSchema,
  slug: slugSchema.nullable().optional(),
  status: universityStatusSchema.optional(),
});
export type CreateUniversityInput = z.infer<typeof createUniversityInputSchema>;

export const updateUniversityInputSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.nullable().optional(),
    status: universityStatusSchema.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.slug !== undefined ||
      data.status !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateUniversityInput = z.infer<typeof updateUniversityInputSchema>;
