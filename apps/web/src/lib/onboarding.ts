// Frontend client for the post-MFA onboarding hooks (UNI-57).
//
// `getOnboardingLmsStep` is called after every successful sign-in
// (credentials-only path, MFA enrollment verify, MFA challenge verify) so
// the SignInPage can route eligible users to /app/onboarding/lms instead
// of their default dashboard. The endpoint is cheap and idempotent — the
// SPA never has to know the four gating rules itself.
//
// `dismissOnboardingLmsStep` stamps `users.lms_onboarding_dismissed_at`
// so the step never returns. Called from the "Skip for now" action.

import type {
  DismissLmsOnboardingResponse,
  LmsOnboardingStepResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function getOnboardingLmsStep(
  signal?: AbortSignal,
): Promise<LmsOnboardingStepResponse> {
  return api.get<LmsOnboardingStepResponse>("/api/onboarding/lms-step", {
    signal,
  });
}

export function dismissOnboardingLmsStep(): Promise<DismissLmsOnboardingResponse> {
  return api.post<DismissLmsOnboardingResponse>(
    "/api/onboarding/lms-step/dismiss",
  );
}
