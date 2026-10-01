// WS4 (SA-606) — the tenant-visible staff order-email setting: `GET/PUT /messaging/staff-email-settings`.
// TENANT_ADMIN writes, OPERATOR reads (addresses masked `j***@host`). `effectiveMode` is READ-ONLY:
// it is min(platform env STAFF_ORDER_EMAIL, the policy term) — a tenant cannot choose it, so the UI
// shows a status line, never an off/dark/on radio. The per-user opt-outs are the preferences
// `staffOrderEmail` / `staffBuyerChangeEmail` ("true" | "false", absent = on), owned by
// users/me/preferences, not by this endpoint.

export const STAFF_ORDER_EMAIL_MODE_VALUES = ["off", "dark", "on"] as const;
export type StaffOrderEmailMode = (typeof STAFF_ORDER_EMAIL_MODE_VALUES)[number];

/** Max "Also send to" addresses. */
export const STAFF_CC_MAX = 5;

export interface StaffEmailSettings {
  /** The optional extra recipients ("Also send to"); masked for an OPERATOR. */
  staffCc: string[];
  effectiveMode: StaffOrderEmailMode;
}

export interface UpdateStaffEmailSettingsRequest {
  staffCc: string[];
}

/** `details.reason` of the 400 `STAFF_CC_INVALID`. */
export const STAFF_CC_INVALID_REASON_VALUES = [
  "format",
  "duplicate",
  "too_many",
  "sentinel",
] as const;
export type StaffCcInvalidReason = (typeof STAFF_CC_INVALID_REASON_VALUES)[number];

export interface StaffCcInvalidDetails {
  /** Index of the offending address in the request array (0 for `too_many`). */
  index: number;
  reason: StaffCcInvalidReason;
}
