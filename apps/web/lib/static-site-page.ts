// The ready-made pages (public/site) are plain files, so the build-time Umami site ID can't reach
// them by itself. app/site-page reads each file and adds the same two tags UmamiScript renders on
// the React pages: Umami's own script, then public/site/analytics.js, which sends the one pageview
// (the tracker is told not to follow the page, as on the React pages).
import {
  brandValue,
  loadPalette,
  paletteCss,
  type Brand,
  type Palette,
} from "@routeflow/types/brand";
import { UMAMI_OWN_DOMAIN, STATIC_SITE_PATHS, umamiScriptProps } from "@/lib/umami-tag";

import {
  STATIC_SITE_PAGES,
  STATIC_SITE_PAGE_NAMES,
  type StaticSitePage,
} from "@/lib/static-site-pages";

// The list lives in a leaf module (the middleware reads it); re-exported so importers keep working.
export { STATIC_SITE_PAGES, STATIC_SITE_PAGE_NAMES, type StaticSitePage };

// Every page's address must be a path the visit counter knows.
STATIC_SITE_PAGES satisfies Record<string, (typeof STATIC_SITE_PATHS)[number]>;

export const ANALYTICS_SRC = "/site/analytics.js";
export const FIRST_TOUCH_SRC = "/site/js/first-touch.js";

const BRAND_TOKEN = /\{\{brand:([^{}]*)\}\}/g;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The one place the palette's colours reach a page: `<style id="brand-tokens">:root{--brand-*}`.
 *  The values are validated hex and the keys hyphenated words, so nothing here can carry markup.
 *  components/brand/BrandTokens.tsx renders the same element for the React pages. */
export const BRAND_TOKENS_ID = "brand-tokens";
export const brandTokensTag = (palette: Palette): string =>
  `<style id="${BRAND_TOKENS_ID}">${paletteCss(palette)}</style>`;

/** The tag at the end of <head>; a page with no <head> (a snippet) or one that has it already is
 *  returned as it is. */
function withBrandTokens(html: string, palette: Palette): string {
  if (html.includes(`id="${BRAND_TOKENS_ID}"`)) return html;
  const at = html.indexOf("</head>");
  if (at < 0) return html;
  return html.slice(0, at) + brandTokensTag(palette) + html.slice(at);
}

/**
 * Fills the `{{brand:key}}` tokens (dotted keys for the nested ones, e.g. `{{brand:logo.onLight}}`)
 * from the brand. Throws on a key the brand does not have and on any `{{brand:` left behind (a
 * malformed token or one with the wrong case), so a page can never be served with a hole in it.
 * Then adds the palette's `<style id="brand-tokens">` to <head> (palette: loadPalette(), mockable;
 * pass `null` for the filled page alone, as the port script's round-trip test needs).
 * Pure: no file access. Values are HTML-escaped; JSON-LD needs a json mode (the home lane, S2).
 */
export function renderSitePage(
  html: string,
  brand: Brand,
  palette: Palette | null = loadPalette(),
): string {
  const out = html.replace(BRAND_TOKEN, (_token, key: string) => {
    const value = brandValue(brand, key.trim());
    if (typeof value !== "string") throw new Error(`renderSitePage: unknown brand key "${key}"`);
    return escapeHtml(value);
  });
  const left = out.search(/\{\{\s*brand\s*:/i);
  if (left >= 0) {
    throw new Error(`renderSitePage: leftover brand token near "${out.slice(left, left + 40)}"`);
  }
  return palette ? withBrandTokens(out, palette) : out;
}

const attr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The two script tags for one page, or "" with no site ID (a local or test stack sends nothing). */
export function visitCountTags(page: StaticSitePage, websiteId: string | undefined): string {
  const path = STATIC_SITE_PAGES[page];
  const props = umamiScriptProps(websiteId, path);
  if (!props) return "";
  const { src, defer, ...data } = props;
  const umami = Object.entries(data)
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(" ");
  return (
    `<script ${defer ? "defer " : ""}src="${src}" ${umami}></script>\n` +
    `<script defer src="${ANALYTICS_SRC}" data-path="${path}" data-own-domain="${UMAMI_OWN_DOMAIN}"></script>\n`
  );
}

/** The page as served: the file itself, plus the visit-count tags just before </body>. */
export function withVisitCount(html: string, page: StaticSitePage, websiteId: string | undefined) {
  const tags = visitCountTags(page, websiteId);
  if (!tags) return html;
  const at = html.lastIndexOf("</body>");
  if (at < 0) throw new Error(`public/site/${page}.html has no </body> to add the visit count to`);
  return html.slice(0, at) + tags + html.slice(at);
}

/** The first-touch script, deferred, just before </head> on every page (no site ID needed). A page that has it
 *  already is returned as it is; a page with no </head> throws, so capture is never silently lost. */
export function withFirstTouch(html: string): string {
  if (html.includes(FIRST_TOUCH_SRC)) return html;
  const at = html.indexOf("</head>");
  if (at < 0)
    throw new Error("withFirstTouch: the page has no </head> to add the first-touch script to");
  return html.slice(0, at) + `<script defer src="${FIRST_TOUCH_SRC}"></script>` + html.slice(at);
}
