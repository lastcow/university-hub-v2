// Frontend client for the settings API (UNI-15).

import type {
  MailgunStatusResponse,
  SessionUser,
  SystemStatusResponse,
  University,
  UpdateSettingsAccountInput,
  UpdateSettingsUniversityInput,
} from "@university-hub/shared";

import { api } from "./api";

export function getMailgunStatus(
  signal?: AbortSignal,
): Promise<MailgunStatusResponse> {
  return api.get<MailgunStatusResponse>("/api/settings/mailgun-status", {
    signal,
  });
}

export function getSystemStatus(
  signal?: AbortSignal,
): Promise<SystemStatusResponse> {
  return api.get<SystemStatusResponse>("/api/settings/system-status", {
    signal,
  });
}

export function updateUniversitySettings(
  input: UpdateSettingsUniversityInput,
  options?: { universityId?: string },
): Promise<University> {
  const path = options?.universityId
    ? `/api/settings/university?university_id=${encodeURIComponent(options.universityId)}`
    : "/api/settings/university";
  return api.patch<University>(path, input);
}

export function updateAccountSettings(
  input: UpdateSettingsAccountInput,
): Promise<SessionUser> {
  return api.patch<SessionUser>("/api/settings/account", input);
}
