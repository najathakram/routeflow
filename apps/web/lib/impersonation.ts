import { clearTenantCookie } from "./tenant-cookie";

/**
 * Super-admin impersonation state — THE single reader/writer for the
 * impersonation localStorage keys (token, tenant slug, acting username).
 * Nothing else may touch these keys directly: stale impersonation state
 * hijacking fresh logins is exactly the bug this module exists to prevent.
 */
const TOKEN_KEY = "impersonationToken";
const SLUG_KEY = "impersonationTenantSlug";
const USERNAME_KEY = "impersonationUsername";
const CHANGE_EVENT = "rf-impersonation-change";

export interface ImpersonationState {
  token: string;
  slug: string;
  username: string | null;
  expired: boolean;
}

function parseExp(token: string): number | null {
  try {
    const seg = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(seg));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export function getImpersonation(): ImpersonationState | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const slug = localStorage.getItem(SLUG_KEY) ?? "unknown";
  const username = localStorage.getItem(USERNAME_KEY);
  const exp = parseExp(token);
  return { token, slug, username, expired: exp !== null && exp * 1000 < Date.now() };
}

export function setImpersonation(token: string, slug: string, username?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SLUG_KEY, slug);
  if (username) {
    localStorage.setItem(USERNAME_KEY, username);
  } else {
    localStorage.removeItem(USERNAME_KEY);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearImpersonation(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SLUG_KEY);
  localStorage.removeItem(USERNAME_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * End an impersonation from the UI. Used by BOTH the red banner and the avatar
 * menu's "Exit impersonation" item (B138) — one copy, never two.
 *
 * Never POSTs /auth/logout: an impersonation token's `sub` is the tenant's
 * TENANT_ADMIN, so a server logout would revoke that admin's sessions on every
 * device. The super-admin's own session carries no tenant, so there is nothing
 * to re-pin the cookie from. Hard-load (not router.push) so every provider —
 * AuthProvider, TenantProvider, the nav — remounts cleanly on the operator
 * session instead of carrying impersonated state over a soft nav.
 */
export function exitImpersonation(): void {
  if (typeof window === "undefined") return;
  clearTenantCookie();
  clearImpersonation();
  window.location.href = "/admin/tenants";
}

/**
 * Re-render hook: fires on set/clear in this tab and on impersonation-key
 * writes from other tabs. The storage listener is key-filtered on purpose — an
 * unfiltered one fires for EVERY cross-tab localStorage write (sidebar state,
 * dashboard view mode, …), and subscribers that re-read the session token would
 * then tear down a perfectly valid session on an unrelated write.
 */
export function subscribeImpersonation(onChange: () => void): () => void {
  function handleStorageEvent(event: StorageEvent) {
    if (event.storageArea !== localStorage) return;
    // key === null means localStorage.clear() — impersonation went with it.
    if (
      event.key !== null &&
      event.key !== TOKEN_KEY &&
      event.key !== SLUG_KEY &&
      event.key !== USERNAME_KEY
    ) {
      return;
    }
    onChange();
  }
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorageEvent);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorageEvent);
  };
}
