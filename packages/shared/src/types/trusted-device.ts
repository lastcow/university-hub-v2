// "Remember this device" trusted-device payload types (UNI-47).
//
// `university_admin` users who tick the checkbox on the MFA challenge
// page get a row in `trusted_devices` and a signed HttpOnly cookie. The
// settings page lists active rows so they can revoke individual devices
// or "revoke all" (e.g. after suspected compromise).

import type { Id, IsoDateString } from "./common.js";

export interface TrustedDeviceListItem {
  id: Id;
  /** /24 (IPv4) or /48 (IPv6) excerpt of the IP captured at grant time. */
  ip_excerpt: string | null;
  user_agent_excerpt: string | null;
  created_at: IsoDateString;
  expires_at: IsoDateString;
  last_used_at: IsoDateString | null;
}

export interface TrustedDeviceListResponse {
  trusted_devices: TrustedDeviceListItem[];
  /** Current configured trust window in days. Surfaced so the UI can show
   *  "Newly-trusted devices last for N days" without a second round-trip. */
  trust_window_days: number;
}

export interface TrustedDeviceRevokeAllResponse {
  revoked_count: number;
}

/** GET /api/settings/system — surface for super_admin-editable scalars. */
export interface SystemSettingsResponse {
  mfa_trusted_device_days: number;
}
