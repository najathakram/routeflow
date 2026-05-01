/**
 * Namespaced localStorage keys for per-role token isolation.
 * NEW-m2-1 / RF-077: operator, driver, and buyer tokens live under separate
 * keys so concurrent same-origin tabs cannot overwrite each other's sessions.
 *
 * Imported by both auth.ts and api-client.ts — kept in a separate file to
 * avoid a circular dependency between those two modules.
 */

export const OP_KEYS = {
  accessToken: "rf:op:accessToken",
  refreshToken: "rf:op:refreshToken",
} as const;

export const BUYER_KEYS = {
  accessToken: "rf:buyer:accessToken",
  refreshToken: "rf:buyer:refreshToken",
  activeSeller: "rf:buyer:activeSeller",
} as const;

// Mobile/driver keys — also used by apps/mobile/lib/auth.ts
export const DRIVER_KEYS = {
  accessToken: "rf:driver:accessToken",
  refreshToken: "rf:driver:refreshToken",
} as const;
