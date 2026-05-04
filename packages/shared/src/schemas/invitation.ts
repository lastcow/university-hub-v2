import { z } from "zod";

import { emailSchema, idSchema, roleSchema } from "./common.js";

export const createInvitationInputSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  university_id: idSchema.nullable().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;
