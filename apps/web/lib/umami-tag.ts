// The Umami visit-count rules that do not need a browser. UmamiScript (the React pages) and the
// ready-made pages (app/site-page, which add the same tag to static HTML) both read them here, so
// the two can't drift. The five rules and their pins are described in components/UmamiScript.tsx.
import { routes, site } from "@/app/(marketing)/lib/site";

export const UMAMI_SCRIPT_SRC = "https://cloud.umami.is/script.js";

// The ready-made pages (public/site). Not in `routes`: /landing is an ad page, not a nav route.
export const STATIC_SITE_PATHS = ["/", "/pricing", "/product", "/landing"] as const;

// The marketing routes come from the one `routes` table; /book-a-demo is a marketing page that is
// not a nav route (see app/sitemap.ts). `/sign-in` is deliberately not here.
const COUNTED_PATHS: ReadonlySet<string> = new Set([
  "/",
  ...routes.map((route) => `/${route.slug}`),
  ...STATIC_SITE_PATHS,
  "/book-a-demo",
  "/signup",
]);

// www, the bare domain and every tenant's host. A tenant's host names a client.
export const UMAMI_OWN_DOMAIN = new URL(site.origin).hostname.replace(/^www\./, "");

export function umamiAllowedPath(pathname: string | null): boolean {
  return pathname !== null && COUNTED_PATHS.has(pathname);
}

export function umamiScriptProps(websiteId: string | undefined, pathname: string | null) {
  const id = websiteId?.trim();
  if (!id || !umamiAllowedPath(pathname)) return null;
  return {
    src: UMAMI_SCRIPT_SRC,
    defer: true,
    "data-website-id": id,
    "data-domains": new URL(site.origin).hostname,
    "data-auto-track": "false",
    "data-exclude-search": "true",
  };
}
