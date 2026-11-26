// Web reader of the brand seam (packages/types/brand/brand.json). Import from
// "@routeflow/types/brand"; deliberately NOT re-exported from the package root, so the API's
// runtime imports never pull it in.
import { loadBrand, siteView, type Brand, type SiteBrand } from "./load";

export {
  BRAND_KEYS,
  BRAND_NUMBER_KEYS,
  SITE_OVERLAY_KEYS,
  brandValue,
  loadBrand,
  loadPalette,
  paletteCss,
  siteView,
  validateBrand,
  validatePalette,
  type Brand,
  type Palette,
  type SiteBrand,
  type SiteOverlay,
} from "./load";

/** The brand, read once when a consumer module loads (through the mockable loadBrand()). */
export const BRAND: Brand = loadBrand();

let cachedSite: { of: Brand; view: SiteBrand } | undefined;

/** The site view of the loaded brand: the one builder of it, through the mockable loadBrand() so a
 *  fixture brand flows through. Read only by the allowlist pinned in
 *  app/(marketing)/site-overlay.static.test.ts; everything else reads BRAND. */
export function loadSiteBrand(): SiteBrand {
  const brand = loadBrand();
  if (cachedSite?.of !== brand) cachedSite = { of: brand, view: siteView(brand) };
  return cachedSite.view;
}

/** The brand as the site shows it (the new name, marks and main host). */
export const SITE_BRAND: SiteBrand = loadSiteBrand();

/** A tab title is at most this long (the search-result cut-off the site audit pinned). */
export const MAX_TITLE_LENGTH = 60;

/** "Page | Name", or the bare name with no page. Never ends a sentence with the name. */
export function pageTitle(page?: string, brand: Brand = loadBrand()): string {
  const title = page ? `${page}${brand.titleSeparator}${brand.name}` : brand.name;
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`pageTitle: "${title}" is ${title.length} chars, over ${MAX_TITLE_LENGTH}`);
  }
  return title;
}

/** The copyright line in the footer. While the previous name is set and differs from the name, the
 *  line says so (the owner's six-month notice); otherwise it is the bare line. */
export function footerLine(year = 2026, brand: SiteBrand = loadBrand()): string {
  const bare = `© ${year} ${brand.name}`;
  return brand.formerly && brand.formerly !== brand.name
    ? `${bare}, formerly ${brand.formerly}`
    : bare;
}

/** The brand's two share lines, as the share image and the og:image alt print them. */
export function shareAlt(brand: SiteBrand = loadBrand()): string {
  return `${brand.name}. ${brand.shareLine}`;
}

/** The footer line of the site pages: the site view's name, with the previous name noted. */
export const siteFooterLine = (year = 2026): string => footerLine(year, loadSiteBrand());

/** The share image alt line of the site pages. */
export const siteShareAlt = (): string => shareAlt(loadSiteBrand());
