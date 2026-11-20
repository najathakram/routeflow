// Server only (reads files): the page as the route serves it, in one function. The route and every
// new test read a ready-made page through readServedSitePage(), so the two cannot diverge. Raw
// reads of public/site/*.html are pinned by app/(marketing)/site-page-read-pin.static.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrand, type Brand } from "@routeflow/types/brand";
import {
  renderSitePage,
  withFirstTouch,
  withVisitCount,
  type StaticSitePage,
} from "@/lib/static-site-page";

export interface ServedPageOptions {
  /** Brand to fill the tokens from. Default: the real one (tests pass a fixture or mock loadBrand). */
  brand?: Brand;
  /** Umami site ID. Default: the build-time NEXT_PUBLIC_UMAMI_WEBSITE_ID (pass `undefined` for none). */
  websiteId?: string | undefined;
}

/** The file itself, tokens and all. `next build` runs in apps/web; a root-level run (a script, a
 *  test) finds it one level down. */
export function readSitePageFile(page: StaticSitePage): string {
  for (const base of [process.cwd(), join(process.cwd(), "apps", "web")]) {
    try {
      return readFileSync(join(base, "public", "site", `${page}.html`), "utf8");
    } catch {
      // try the next place
    }
  }
  throw new Error(`public/site/${page}.html not found from ${process.cwd()}`);
}

/** The page as served: file, brand tokens filled, then the first-touch script, then the visit-count tags. */
export function readServedSitePage(page: StaticSitePage, opts: ServedPageOptions = {}): string {
  // Written out in full so Next inlines it at build time, as in UmamiScript.
  const websiteId = "websiteId" in opts ? opts.websiteId : process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  const filled = renderSitePage(readSitePageFile(page), opts.brand ?? loadBrand());
  return withVisitCount(withFirstTouch(filled), page, websiteId);
}
