import { z } from "zod";

import { emailSchema } from "./common.js";

export const contactMessageInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: emailSchema,
  message: z.string().trim().min(1, "Message is required").max(4000),
});

export type ContactMessageInput = z.infer<typeof contactMessageInputSchema>;
