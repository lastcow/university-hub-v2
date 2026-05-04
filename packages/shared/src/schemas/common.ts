import { z } from "zod";

import {
  CONTACT_MESSAGE_STATUSES,
  COURSE_ASSIGNMENT_ROLES,
  COURSE_STATUSES,
  EMAIL_LOG_STATUSES,
  EMAIL_TYPES,
  INVITATION_STATUSES,
  ROLES,
  UNIVERSITY_STATUSES,
  USER_STATUSES,
} from "../constants/index.js";

export const idSchema = z.string().uuid();

export const isoDateStringSchema = z.string().datetime({ offset: true });

export const emailSchema = z.string().trim().toLowerCase().email();

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");

export const roleSchema = z.enum(ROLES);

export const userStatusSchema = z.enum(USER_STATUSES);

export const invitationStatusSchema = z.enum(INVITATION_STATUSES);

export const universityStatusSchema = z.enum(UNIVERSITY_STATUSES);

export const courseStatusSchema = z.enum(COURSE_STATUSES);

export const contactMessageStatusSchema = z.enum(CONTACT_MESSAGE_STATUSES);

export const emailLogStatusSchema = z.enum(EMAIL_LOG_STATUSES);

export const emailTypeSchema = z.enum(EMAIL_TYPES);

export const courseAssignmentRoleSchema = z.enum(COURSE_ASSIGNMENT_ROLES);
