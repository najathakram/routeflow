/**
 * Auth presence cookies — the ONLY signed-in signal visible to the Next.js
 * middleware (JWTs live in localStorage, which the server can't read).
 *
 * The middleware uses these to (a) bounce buyers off operator paths and
 * (b) auto-redirect signed-in users from the landing page. For (b) to be safe
 * the cookie must never outlive the session it advertises — the previous
 * client-side redirect was reverted precisely because stale state caused a
 * `/` → `/dashboard` → `/login` bounce that hid the marketing site. Hence:
 *
 *  - max-age tracks the API refresh-token TTL (JWT_REFRESH_EXPIRES_IN = "30d"
 *    in apps/api/src/config/configuration.ts);
 *  - callers re-set the cookie on every successful token refresh (sliding
 *    window) and clear it whenever a refresh is rejected.
 *
 * Dependency-free on purpose: imported by both auth.ts and api-client.ts,
 * which must not import each other.
 */

export const OP_PRESENCE_COOKIE = "rf-op-auth";
export const BUYER_PRESENCE_COOKIE = "rf-buyer-auth";

/** Must match the API refresh-token TTL (30 days). */
export const PRESENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function setPresenceCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=1; path=/; max-age=${PRESENCE_COOKIE_MAX_AGE}; samesite=lax`;
}

function clearPresenceCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

export function setOpPresenceCookie(): void {
  setPresenceCookie(OP_PRESENCE_COOKIE);
}

export function clearOpPresenceCookie(): void {
  clearPresenceCookie(OP_PRESENCE_COOKIE);
}

export function setBuyerPresenceCookie(): void {
  setPresenceCookie(BUYER_PRESENCE_COOKIE);
}

export function clearBuyerPresenceCookie(): void {
  clearPresenceCookie(BUYER_PRESENCE_COOKIE);
}
