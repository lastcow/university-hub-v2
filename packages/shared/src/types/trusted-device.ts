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
  /** UNI-49: human label like "Chrome on macOS" derived from the User-
   *  Agent at grant time. Surfaced in the trusted-devices Settings UI. */
  label: string | null;
  created_at: IsoDateString;
  expires_at: IsoDateString;
  last_used_at: IsoDateString | null;
  /** UNI-49: when this fingerprint last completed an MFA challenge. */
  last_mfa_at: IsoDateString | null;
  /** UNI-49: when this fingerprint was last observed on a sign-in
   *  attempt (regardless of whether MFA ran). */
  last_seen_at: IsoDateString | null;
  /** UNI-49: `true` when the row has no signed cookie (fingerprint-only
   *  trust under the risk-based gate) — distinguishes UNI-47 cookie-bypass
   *  rows from UNI-49 risk-based rows in the UI. */
  fingerprint_only: boolean;
}

export interface TrustedDeviceListResponse {
  trusted_devices: TrustedDeviceListItem[];
  /** Current configured trust window in days for the cookie-bypass path
   *  (UNI-47, university_admin only). Surfaced so the UI can show
   *  "Newly-trusted devices last for N days" without a second round-trip. */
  trust_window_days: number;
  /** UNI-49: revalidation window for the risk-based MFA gate. */
  revalidation_days: number;
}

export interface TrustedDeviceRevokeAllResponse {
  revoked_count: number;
}

/** GET /api/settings/system — surface for super_admin-editable scalars. */
export interface SystemSettingsResponse {
  mfa_trusted_device_days: number;
  /** UNI-49: rolling window for the risk-based MFA gate (1..365). */
  mfa_revalidation_days: number;
}
