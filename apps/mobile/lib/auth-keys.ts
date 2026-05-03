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

/**
 * Marker for the role whose token should currently be used. Written on
 * successful login, cleared on logout. Without it, getStoredUser() falls
 * back to an op-then-driver iteration and any stale token in another bucket
 * can hijack the active session (deep-audit 2026-05-02 BUG-XR1-4).
 */
export const CURRENT_ROLE_KEY = "rf:currentRole";
export type CurrentRole = "operator" | "driver" | "buyer";
