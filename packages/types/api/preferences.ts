/**
 * Per-user preference keys — the ONE declaration shared by api (allow-list), web and mobile.
 * `PATCH /users/me/preferences` rejects any key not listed here (SA-602a); a client writes
 * through `PREF.<name>` so a renamed or dropped key is a compile error, not a silent 400.
 */
export const PREF = {
  lowStockDigestEnabled: "lowStockDigestEnabled",
  pushEnabled: "pushEnabled",
  staffOrderEmail: "staffOrderEmail",
  staffBuyerChangeEmail: "staffBuyerChangeEmail",
  locale: "locale",
  billLastSupplierId: "bill.lastSupplierId",
  paymentLastMethod: "payment.lastMethod",
} as const;

export const PREFERENCE_KEYS = [
  PREF.lowStockDigestEnabled,
  PREF.pushEnabled,
  PREF.staffOrderEmail,
  PREF.staffBuyerChangeEmail,
  PREF.locale,
  PREF.billLastSupplierId,
  PREF.paymentLastMethod,
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** Body of PATCH /users/me/preferences: a partial map of allow-listed keys to string values. */
export type PreferencePatch = Partial<Record<PreferenceKey, string>>;
