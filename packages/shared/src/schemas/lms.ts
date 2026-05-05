// LMS-related zod schemas (epic UNI-50 / sub-issue UNI-53).
//
// Validates the body of `POST /api/lms/provider-configs` (create or
// update) on both the route handler and the React form. The schema is
// strict: `base_url` must be HTTPS, `client_id` must be non-empty,
// `client_secret` must be non-empty *on first configure* — the route
// handler layers in the "row already exists → blank secret means keep
// the existing one" logic on top of this.

import { z } from "zod";

const PROVIDER_IDS = [
  "canvas",
  "blackboard",
  "moodle",
  "google_classroom",
] as const;

const baseUrlSchema = z
  .string()
  .trim()
  .min(1, "Base URL is required")
  .max(500, "Base URL is too long")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Base URL must be a valid https:// URL");

const clientIdSchema = z
  .string()
  .trim()
  .min(1, "Client ID is required")
  .max(255, "Client ID is too long");

// Optional on the wire: an empty string OR an absent property both mean
// "keep the existing secret" on update. The route handler rejects empty
// values when there is no existing row to fall back to.
const clientSecretSchema = z
  .string()
  .max(2_000, "Client secret is too long")
  .optional();

export const updateLmsProviderConfigInputSchema = z.object({
  provider_id: z.enum(PROVIDER_IDS),
  base_url: baseUrlSchema,
  client_id: clientIdSchema,
  client_secret: clientSecretSchema,
  enabled: z.boolean(),
});

export type UpdateLmsProviderConfigInput = z.infer<
  typeof updateLmsProviderConfigInputSchema
>;
