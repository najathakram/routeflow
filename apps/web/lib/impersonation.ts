/**
 * Super-admin impersonation state — THE single reader/writer for the
 * impersonation localStorage keys. Nothing else may touch these keys directly:
 * stale impersonation state hijacking fresh logins is exactly the bug this
 * module exists to prevent.
 */
const TOKEN_KEY = "impersonationToken";
const SLUG_KEY = "impersonationTenantSlug";
const CHANGE_EVENT = "rf-impersonation-change";

export interface ImpersonationState {
  token: string;
  slug: string;
  expired: boolean;
}

function parseExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
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
  const exp = parseExp(token);
  return { token, slug, expired: exp !== null && exp * 1000 < Date.now() };
}

export function setImpersonation(token: string, slug: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SLUG_KEY, slug);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearImpersonation(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SLUG_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Re-render hook for the banner: fires on set/clear in this tab and on storage from others. */
export function subscribeImpersonation(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
