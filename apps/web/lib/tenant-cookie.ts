/**
 * Shared utility for managing the tenant-slug cookie.
 *
 * The tenant-slug cookie is the mechanism that tells the Axios interceptor
 * which tenant to send in the X-Tenant-Slug header with every API request.
 * It must be kept in sync with the actual tenant context at all times.
 */

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function setTenantCookie(slug: string): void {
  document.cookie = `tenant-slug=${encodeURIComponent(slug)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

/** Read the tenant-slug cookie set by the Next.js middleware or login form. */
export function getTenantCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

export function clearTenantCookie(): void {
  document.cookie = "tenant-slug=; path=/; max-age=0; path=/";
}
