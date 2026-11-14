// The ready-made pages (public/site) are plain files, so the build-time Umami site ID can't reach
// them by itself. app/site-page reads each file and adds the same two tags UmamiScript renders on
// the React pages: Umami's own script, then public/site/analytics.js, which sends the one pageview
// (the tracker is told not to follow the page, as on the React pages).
import { brandValue, type Brand } from "@routeflow/types/brand";
import { UMAMI_OWN_DOMAIN, STATIC_SITE_PATHS, umamiScriptProps } from "@/lib/umami-tag";

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
} as const satisfies Record<string, (typeof STATIC_SITE_PATHS)[number]>;

export type StaticSitePage = keyof typeof STATIC_SITE_PAGES;

export const STATIC_SITE_PAGE_NAMES = Object.keys(STATIC_SITE_PAGES) as StaticSitePage[];

export const ANALYTICS_SRC = "/site/analytics.js";

const BRAND_TOKEN = /\{\{brand:([^{}]*)\}\}/g;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Fills the `{{brand:key}}` tokens (dotted keys for the nested ones, e.g. `{{brand:logo.onLight}}`)
 * from the brand. Throws on a key the brand does not have and on any `{{brand:` left behind (a
 * malformed token or one with the wrong case), so a page can never be served with a hole in it.
 * Pure: no file access. Values are HTML-escaped; JSON-LD needs a json mode (the home lane, S2).
 */
export function renderSitePage(html: string, brand: Brand): string {
  const out = html.replace(BRAND_TOKEN, (_token, key: string) => {
    const value = brandValue(brand, key.trim());
    if (typeof value !== "string") throw new Error(`renderSitePage: unknown brand key "${key}"`);
    return escapeHtml(value);
  });
  const left = out.search(/\{\{\s*brand\s*:/i);
  if (left >= 0) {
    throw new Error(`renderSitePage: leftover brand token near "${out.slice(left, left + 40)}"`);
  }
  return out;
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
