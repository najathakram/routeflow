// The ready-made pages and the address each is served at: the one list the route, the raw-path
// guard in middleware.ts and the tests read. A leaf on purpose (no import at all), so the middleware
// that guards the raw files never loads the brand files, the renderer or the page libraries.
/** File name (public/site/<name>.html) -> the address the page is served at. */
export const STATIC_SITE_PAGES = {
  home: "/",
  pricing: "/pricing",
  product: "/product",
  landing: "/landing",
  "getting-started": "/getting-started",
  "does-and-doesnt": "/does-and-doesnt",
  "data-in-and-out": "/data-in-and-out",
  security: "/security",
  company: "/company",
  contact: "/contact",
} as const;

export type StaticSitePage = keyof typeof STATIC_SITE_PAGES;

export const STATIC_SITE_PAGE_NAMES = Object.keys(STATIC_SITE_PAGES) as StaticSitePage[];
