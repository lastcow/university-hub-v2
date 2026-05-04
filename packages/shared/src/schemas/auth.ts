import { z } from "zod";

import { emailSchema, passwordSchema } from "./common.js";

export const signInInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export type SignInInput = z.infer<typeof signInInputSchema>;

export const acceptInvitationInputSchema = z
  .object({
    token: z.string().min(1, "Token is required"),
    // The invited email is shown read-only in the UI but echoed back in the
    // payload so the backend can detect form tampering — see UNI-10
    // acceptance criterion "email mismatch is rejected".
    email: emailSchema,
    name: z.string().trim().min(1, "Name is required"),
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;
