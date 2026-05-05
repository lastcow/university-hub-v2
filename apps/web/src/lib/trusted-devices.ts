// Client for the "Trusted devices" management surface (UNI-47).

import type {
  SystemSettingsResponse,
  TrustedDeviceListResponse,
  TrustedDeviceRevokeAllResponse,
} from "@university-hub/shared";

import { api } from "./api";

export function listMyTrustedDevices(
  signal?: AbortSignal,
): Promise<TrustedDeviceListResponse> {
  return api.get<TrustedDeviceListResponse>("/api/auth/trusted-devices", {
    signal,
  });
}

export function revokeMyTrustedDevice(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/api/auth/trusted-devices/${id}`);
}

export function revokeAllMyTrustedDevices(): Promise<TrustedDeviceRevokeAllResponse> {
  return api.post<TrustedDeviceRevokeAllResponse>(
    "/api/auth/trusted-devices/revoke-all",
  );
}

export function listUserTrustedDevices(
  userId: string,
  signal?: AbortSignal,
): Promise<TrustedDeviceListResponse> {
  return api.get<TrustedDeviceListResponse>(
    `/api/users/${userId}/trusted-devices`,
    { signal },
  );
}

export function revokeAllUserTrustedDevices(
  userId: string,
): Promise<TrustedDeviceRevokeAllResponse> {
  return api.post<TrustedDeviceRevokeAllResponse>(
    `/api/users/${userId}/trusted-devices/revoke-all`,
  );
}

export function getSystemSettings(
  signal?: AbortSignal,
): Promise<SystemSettingsResponse> {
  return api.get<SystemSettingsResponse>("/api/settings/system", { signal });
}

export function updateSystemSettings(input: {
  mfa_trusted_device_days?: number;
}): Promise<SystemSettingsResponse> {
  return api.patch<SystemSettingsResponse>("/api/settings/system", input);
}
