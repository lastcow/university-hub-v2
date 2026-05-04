import { z } from "zod";

import { GRADE_STATUSES } from "../constants/statuses.js";

import { idSchema, isoDateStringSchema } from "./common.js";

const titleSchema = z
  .string()
  .trim()
  .min(2, "Title is required")
  .max(160, "Title is too long");

const descriptionSchema = z
  .string()
  .trim()
  .max(4000, "Description is too long");

const weightSchema = z
  .number()
  .min(0, "Weight must be 0 or greater")
  .max(1, "Weight must be 1 or less");

const maxScoreSchema = z
  .number()
  .gt(0, "Max score must be greater than 0")
  .max(100000, "Max score is too large");

export const createAssessmentInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.nullable().optional(),
  weight: weightSchema.optional(),
  max_score: maxScoreSchema.optional(),
  due_at: isoDateStringSchema.nullable().optional(),
});
export type CreateAssessmentInput = z.infer<typeof createAssessmentInputSchema>;

export const updateAssessmentInputSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    weight: weightSchema.optional(),
    max_score: maxScoreSchema.optional(),
    due_at: isoDateStringSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.description !== undefined ||
      data.weight !== undefined ||
      data.max_score !== undefined ||
      data.due_at !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateAssessmentInput = z.infer<typeof updateAssessmentInputSchema>;

export const gradeStatusSchema = z.enum(GRADE_STATUSES);

const scoreSchema = z
  .number()
  .min(0, "Score cannot be negative")
  .max(100000, "Score is too large");

const letterGradeSchema = z
  .string()
  .trim()
  .min(1, "Letter grade cannot be empty")
  .max(8, "Letter grade is too long");

const feedbackSchema = z
  .string()
  .trim()
  .max(4000, "Feedback is too long");

export const createGradeInputSchema = z.object({
  assessment_id: idSchema,
  student_user_id: idSchema,
  score: scoreSchema.nullable().optional(),
  letter_grade: letterGradeSchema.nullable().optional(),
  feedback: feedbackSchema.nullable().optional(),
  status: gradeStatusSchema.optional(),
});
export type CreateGradeInput = z.infer<typeof createGradeInputSchema>;

export const updateGradeInputSchema = z
  .object({
    score: scoreSchema.nullable().optional(),
    letter_grade: letterGradeSchema.nullable().optional(),
    feedback: feedbackSchema.nullable().optional(),
    status: gradeStatusSchema.optional(),
  })
  .refine(
    (data) =>
      data.score !== undefined ||
      data.letter_grade !== undefined ||
      data.feedback !== undefined ||
      data.status !== undefined,
    { message: "At least one field is required" },
  );
export type UpdateGradeInput = z.infer<typeof updateGradeInputSchema>;
