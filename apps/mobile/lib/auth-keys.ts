/**
 * Namespaced storage keys for per-role token isolation.
 * NEW-m2-1 / RF-077: operator, driver, and buyer tokens live under separate
 * keys so concurrent same-origin tabs (web) or app contexts cannot overwrite
 * each other's sessions.
 */

export const OP_KEYS = {
  accessToken: "rf:op:accessToken",
  refreshToken: "rf:op:refreshToken",
} as const;

export const DRIVER_KEYS = {
  accessToken: "rf:driver:accessToken",
  refreshToken: "rf:driver:refreshToken",
} as const;

export const BUYER_KEYS = {
  accessToken: "rf:buyer:accessToken",
  refreshToken: "rf:buyer:refreshToken",
  activeSeller: "rf:buyer:activeSeller",
} as const;
