/**
 * The public marketing page paths — plus the auth entry points and the
 * same-origin assets those pages need — in one place.
 *
 * Single source for every consumer that has to answer "is this URL a public
 * marketing page?" — `middleware.ts` (mobile-web proxy carve-out),
 * `lib/api-client.ts` and `lib/auth-context.tsx` (never punt a visitor on a
 * public page to /login). Hand-typed mirrors of this list are exactly how the
 * `/privacy` + `/terms` miss shipped — never restate it elsewhere (lesson
 * L-072); import it.
 *
 * Kept set-equal to the marketing `routes` table in
 * `app/(marketing)/lib/site.ts` (plus "/" and "/distributors", which have no
 * `routes` row) by the parity test in
 * `app/(marketing)/middleware.marketing.test.ts`.
 *
 * Dependency-free on purpose: the middleware runs on the edge runtime and must
 * not pull in the marketing app tree.
 */
export const MARKETING_PAGE_PATHS = [
  "/",
  "/product",
  "/wholesalers",
  "/retailers",
  "/pricing",
  "/company",
  "/contact",
  "/privacy",
  "/terms",
  "/distributors",
] as const;

/**
 * Auth entry points the marketing chrome links on every page.
 *
 * The header dropdown, the mobile sheet and the footer's "Your workspace"
 * column link `/login`, `/signup`, `/buyer/login` and `/buyer/register`
 * (`app/(marketing)/components/auth-links.ts`). Three of the four have no route
 * in the Expo mobile-web build, so proxying them for a phone UA drops the
 * visitor on the Expo app's own landing screen with no way to sign up.
 *
 * `/login` is deliberately ABSENT: the mobile-web login IS the operator entry
 * point on a phone, so the chrome's "Sign in" landing a phone in the app is the
 * intended contract, not a bug.
 */
export const MARKETING_AUTH_PATHS = ["/signup", "/buyer/login", "/buyer/register"] as const;

/**
 * Same-origin static asset prefixes the public pages reference.
 *
 * `/brand/` (icons, apple-touch-icon, OG image) and `/marketing/` (hero
 * photography) are real directories under `apps/web/public`. There is no
 * `public/video` on this branch and nothing references `/video/`, so no such
 * prefix is listed — an allow-list entry for a directory that does not exist
 * only carves paths out of the proxy for Next to 404.
 */
export const MARKETING_ASSET_PREFIXES = ["/brand/", "/marketing/"] as const;

/**
 * Same-origin non-page files the public pages reference by exact path.
 *
 * `manifest` links in `app/layout.tsx` / `app/buyer/layout.tsx`, and `/sw.js`
 * from `components/ServiceWorkerRegistry.tsx`. `/sw.js` is safe to exempt
 * because the Expo build has no service worker of its own:
 * `grep -rn "serviceWorker\|sw\.js" apps/mobile --include=*.ts --include=*.tsx --include=*.js -l`
 * (node_modules excluded) returns nothing, so nothing the mobile-web build
 * serves needs that path to keep proxying.
 *
 * `/favicon.ico` is already excluded by the middleware `config.matcher`; it is
 * listed anyway so the carve-out survives a matcher edit.
 *
 * `/robots.txt` and `/sitemap.xml` are deliberately NOT here — they are exact
 * marketing paths already carried by `MARKETING_PATHS` in `middleware.ts`, and
 * a second copy is the drift this module exists to prevent (L-072).
 *
 * This is an explicit allow-list, never a `*.json` / `*.js` extension rule: the
 * mobile-web build's OWN subresources (its Expo manifest and JS bundles) must
 * keep proxying to the Railway origin.
 */
export const MARKETING_ASSET_FILES = [
  "/operator-manifest.json",
  "/buyer-manifest.json",
  "/sw.js",
  "/favicon.ico",
] as const;

/**
 * True when `pathname` is a same-origin asset the public marketing pages need
 * served by Next rather than proxied to the mobile-web build (R11 / A1).
 */
export function isMarketingAsset(pathname: string): boolean {
  return (
    MARKETING_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    (MARKETING_ASSET_FILES as readonly string[]).includes(pathname)
  );
}
