// Web reader of the brand seam (packages/types/brand/brand.json). Import from
// "@routeflow/types/brand"; deliberately NOT re-exported from the package root, so the API's
// runtime imports never pull it in.
import { loadBrand, type Brand } from "./load";

export {
  BRAND_KEYS,
  BRAND_NUMBER_KEYS,
  brandValue,
  loadBrand,
  loadPalette,
  paletteCss,
  validateBrand,
  validatePalette,
  type Brand,
  type Palette,
} from "./load";

/** The brand, read once when a consumer module loads (through the mockable loadBrand()). */
export const BRAND: Brand = loadBrand();

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
export function footerLine(year = 2026, brand: Brand = loadBrand()): string {
  const bare = `© ${year} ${brand.name}`;
  return brand.formerly && brand.formerly !== brand.name
    ? `${bare}, formerly ${brand.formerly}`
    : bare;
}

/** The brand's two share lines, as the share image and the og:image alt print them. */
export function shareAlt(brand: Brand = loadBrand()): string {
  return `${brand.name}. ${brand.shareLine}`;
}
