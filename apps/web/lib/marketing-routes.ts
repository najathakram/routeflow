/**
 * The public marketing page paths, in one place.
 *
 * Single source for every consumer that has to answer "is this URL a public
 * marketing page?" — `lib/api-client.ts` and `lib/auth-context.tsx` (never
 * punt a visitor on a public page to /login). Hand-typed mirrors of this list
 * are exactly how the `/privacy` + `/terms` miss shipped — never restate it
 * elsewhere (lesson L-072); import it.
 *
 * Kept set-equal to the marketing `routes` table in
 * `app/(marketing)/lib/site.ts` (plus "/" and "/distributors", which have no
 * `routes` row) by the parity test in
 * `app/(marketing)/middleware.marketing.test.ts`.
 *
 * MARKETING_AUTH_PATHS, WEB_ONLY_EXACT_PATHS/WEB_ONLY_PATH_PREFIX/
 * isWebOnlyPath, and MARKETING_ASSET_PREFIXES/MARKETING_ASSET_FILES/
 * isMarketingAsset used to live here too, alongside this list — all four were
 * exemptions for `middleware.ts`'s mobile-UA proxy to the Expo mobile-web
 * build. Owner ruling: phones now get the same redesigned Next web site as
 * desktop (drivers use the installed app instead), so the proxy — and every
 * carve-out that existed only to route around it — is gone. Removed rather
 * than kept dead: confirmed via grep across both `apps/web` and `apps/mobile`
 * that nothing else imported any of the four.
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
