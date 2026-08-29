/**
 * Single source of truth for deriving a tenant slug from a hostname.
 *
 * This logic used to exist twice — in `middleware.ts` and in the login page's
 * own `getSubdomainWorkspace()` — and the two copies DIVERGED. The login page
 * never received the hosting-provider guard, so on `*.up.railway.app` it treated
 * "routeflowweb-production" as a tenant slug: it hid the Workspace field (which
 * is only hidden when the host implies a workspace) and, on submit, wrote that
 * nonexistent slug into the tenant-slug cookie. Form login was therefore
 * impossible on the Railway fallback URL — the documented fallback host and the
 * default `PLAYWRIGHT_BASE_URL`, which is why one e2e spec had been failing on
 * every master run for weeks.
 *
 * Both callers now import from here. Do not re-inline either set.
 */

/** Reserved first labels that are the platform itself, never a tenant. */
export const PLATFORM_HOSTS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "static",
  "assets",
  "mail",
  "support",
  "platform",
  "billing",
  "localhost",
]);

/**
 * Hosting-provider base domains — never extract a tenant slug from these. The
 * first label on such a host is a SERVICE name (e.g. "routeflowweb-production"),
 * not a customer.
 */
export const HOSTING_PROVIDER_DOMAINS = new Set([
  "railway.app",
  "up.railway.app",
  "vercel.app",
  "netlify.app",
  "render.com",
  "fly.dev",
  "onrender.com",
  "herokuapp.com",
]);

/**
 * Returns the tenant slug implied by `hostname`, or null when the host implies
 * no tenant and the user must choose a workspace explicitly.
 *
 * null for: bare domains and localhost (<3 labels), platform hosts
 * (www/app/admin/...), and every hosting-provider domain.
 * "acme" for: acme.routeflow.info.
 */
export function tenantSlugFromHostname(hostname: string): string | null {
  const parts = hostname.split(".");
  if (parts.length < 3) return null; // bare domain or localhost

  // Check against known hosting provider base domains (last 2 or 3 parts).
  const twoPartBase = parts.slice(-2).join(".");
  const threePartBase = parts.slice(-3).join(".");
  if (HOSTING_PROVIDER_DOMAINS.has(twoPartBase) || HOSTING_PROVIDER_DOMAINS.has(threePartBase)) {
    return null;
  }

  const subdomain = parts[0];
  if (!subdomain || PLATFORM_HOSTS.has(subdomain)) return null;
  return subdomain;
}
