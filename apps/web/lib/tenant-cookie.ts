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

export function clearTenantCookie(): void {
  document.cookie = "tenant-slug=; path=/; max-age=0; path=/";
}
