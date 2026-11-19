// Shared test data for the brand seam: T35 (site-brand-seam.static.test.ts) and T45
// (site-brand-fixture.test.ts) both read this one table, so neither hard-codes which pages are still
// untokenised. It lives outside app/(marketing) on purpose: T35 scans that folder's non-test files
// and this file holds the predicate itself.

/** The waves of the rebrand plan. A row names the wave whose lane removes it. */
export type Wave = "W1" | "W1b" | "W2" | "W3";

/** The one predicate source (the spec mandates it): today's brand in any spelling, a typed host or
 *  the old mailbox prefix, and the planned name. Everything below is built from these two parts. */
const CURRENT_SOURCE = String.raw`route\s?flow|routeflow\.info|hello@`;
const PLANNED_SOURCE = "rovio|xrov";
export const BRAND_LITERAL_SOURCE = `${CURRENT_SOURCE}|${PLANNED_SOURCE}`;
export const brandLiteral = (flags = "gi") => new RegExp(BRAND_LITERAL_SOURCE, flags);
/** The current brand alone (a fixture build must show none of it). */
export const CURRENT_BRAND = new RegExp(`${CURRENT_SOURCE}|security@`, "i");

export type Scope = "file" | "comments" | "hex";

export interface Exemption {
  /** One file (relative to apps/web). Never a directory: a row exempts exactly what needs it. */
  path: string;
  /** file: every check is off. comments: the name may appear in comments only. hex: colours only. */
  scope: Scope;
  /** The wave whose lane removes this row. */
  liftedBy: Wave;
  /** The lane's id in the spec delta. */
  lane: string;
}

export const EXEMPT: Exemption[] = [
  // 62 hex in style/fill stay until W3 (the home colour pass).
  { path: "public/site/home.html", scope: "hex", liftedBy: "W3", lane: "2.3-home" },
  { path: "public/site/graphics/rf-wheel-up.js", scope: "file", liftedBy: "W2", lane: "2.2" },
  { path: "public/site/graphics/rf-wheel-up.css", scope: "file", liftedBy: "W2", lane: "2.2" },
  { path: "public/site/css/site.css", scope: "comments", liftedBy: "W2", lane: "2.1b" },
  { path: "public/site/css/home.css", scope: "comments", liftedBy: "W2", lane: "2.1b" },
  { path: "public/site/product.html", scope: "hex", liftedBy: "W3", lane: "2.3-inner" },
  { path: "public/site/security.html", scope: "hex", liftedBy: "W3", lane: "2.3-inner" },
  // Not in the delta's table: the same lane and the same pattern (--pc/--pi tile colours).
  { path: "public/site/getting-started.html", scope: "hex", liftedBy: "W3", lane: "2.3-inner" },
  { path: "public/site/does-and-doesnt.html", scope: "hex", liftedBy: "W3", lane: "2.3-inner" },
  { path: "public/site/data-in-and-out.html", scope: "hex", liftedBy: "W3", lane: "2.3-inner" },
];

/** The rows that cover a file: the one matcher (T35, T45 and the staleness check all use it). */
export const exemptionFor = (file: string, rows: Exemption[] = EXEMPT): Exemption[] =>
  rows.filter((e) => file === e.path);

/** True when every check is off for the file (an untokenised page, a screen of a later lane). */
export const isFileExempt = (file: string): boolean =>
  exemptionFor(file).some((e) => e.scope === "file");
