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

export type Portal = "op" | "buyer";

/**
 * Which portal's authenticated layout rendered last. The landing page ("/")
 * prefers it when BOTH presence cookies are set; it never overrides a missing
 * session (lib/portal-routing.ts). Same lifetime/attributes as the presence
 * cookies; written client-side by the two portal layouts.
 */
export const LAST_PORTAL_COOKIE = "rf-last-portal";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

/** True only when the operator presence cookie is present with value "1". */
export function hasOpPresence(): boolean {
  return readCookie(OP_PRESENCE_COOKIE) === "1";
}

/** True only when the buyer presence cookie is present with value "1". */
export function hasBuyerPresence(): boolean {
  return readCookie(BUYER_PRESENCE_COOKIE) === "1";
}

export function setLastPortalCookie(portal: Portal): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LAST_PORTAL_COOKIE}=${portal}; path=/; max-age=${PRESENCE_COOKIE_MAX_AGE}; samesite=lax`;
}
