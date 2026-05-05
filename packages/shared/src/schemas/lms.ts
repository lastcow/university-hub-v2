// LMS-related zod schemas (epic UNI-50 / reshaped in UNI-63).
//
// Two write surfaces validated here:
//
//   1. `POST /api/lms/provider-configs` — admin-only per-university
//      config. UNI-63 dropped the OAuth `client_id` / `client_secret`
//      fields; admins now configure only the institution's `base_url`
//      and the enabled flag. An optional `test_pat` field lets the
//      admin probe the URL with a Canvas PAT at save-time; the value
//      is never stored.
//   2. `POST /api/lms/connections/canvas` — user-facing PAT submit.
//      Replaces the OAuth `/start` + `/callback` pair. The handler
//      validates the PAT against `<base_url>/api/v1/users/self` and
//      stores the encrypted PAT only on a 200 response.
//
// Sync-run inputs (UNI-55) are unchanged.

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
      // Reject anything that isn't a clean https origin. Canvas tenant
      // URLs never carry a path; rejecting one rules out copy-paste
      // mistakes like `https://canvas.example.edu/login` ending up in
      // the config row and breaking every subsequent REST call.
      if (u.protocol !== "https:") return false;
      if (u.pathname !== "/" && u.pathname !== "") return false;
      if (u.search !== "" || u.hash !== "") return false;
      return true;
    } catch {
      return false;
    }
  }, "Base URL must be an https:// origin with no path or query");

// Personal Access Token shape used both as the admin's optional
// validate-on-save probe and on the user-facing connect endpoint.
// Canvas PATs are opaque strings; we cap the length to keep a
// malicious payload from stuffing a multi-kilobyte value into a
// stored row but otherwise don't constrain content.
const personalAccessTokenSchema = z
  .string()
  .min(1, "Personal access token is required")
  .max(2_000, "Personal access token is too long");

export const updateLmsProviderConfigInputSchema = z.object({
  provider_id: z.enum(PROVIDER_IDS),
  base_url: baseUrlSchema,
  enabled: z.boolean(),
  /** Optional admin-supplied PAT used to probe the configured base URL
   *  on save (`GET <base_url>/api/v1/users/self`). The handler MUST
   *  drop this on the floor after the probe — never persist it,
   *  never echo it back. */
  test_pat: personalAccessTokenSchema.optional(),
});

export type UpdateLmsProviderConfigInput = z.infer<
  typeof updateLmsProviderConfigInputSchema
>;

// `POST /api/lms/connections/canvas` body. The user pastes a PAT they
// generated in Canvas (Account → Settings → "+ New Access Token") and
// the Worker validates it against `/api/v1/users/self` before
// encrypting and storing.
export const connectCanvasConnectionInputSchema = z.object({
  personal_access_token: personalAccessTokenSchema,
});

export type ConnectCanvasConnectionInput = z.infer<
  typeof connectCanvasConnectionInputSchema
>;

// `POST /api/lms/sync-runs/preview` and `POST /api/lms/sync-runs`
// (UNI-55). Both bodies are the same: pick a connection + term. The
// connection's tenant scoping (caller must own it) and the provider
// resolution happen in the route handler — schema-level we just want
// well-formed UUID + non-empty term.
export const lmsSyncRunInputSchema = z.object({
  connection_id: z.string().uuid("connection_id must be a UUID"),
  term_id: z
    .string()
    .trim()
    .min(1, "term_id is required")
    .max(255, "term_id is too long"),
});

export type LmsSyncRunInputSchema = z.infer<typeof lmsSyncRunInputSchema>;
