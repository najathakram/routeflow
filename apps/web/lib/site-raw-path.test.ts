/**
 * @jest-environment node
 */
// A ready-made page asked for by its file name (/site/<page>.html) is the raw file with unfilled
// {{brand:key}} tokens. next.config.mjs redirects the plain spelling; middleware.ts guards every
// other spelling through this normaliser (the encoded path reaches `public/` after decoding, so the
// config redirect, which matches the encoded path, misses it). One table of spellings, one result.
import { classifySitePath } from "./site-raw-path";
import { STATIC_SITE_PAGES, STATIC_SITE_PAGE_NAMES } from "./static-site-page";

const BS = String.fromCharCode(92);
const enc = (s: string) =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");

describe("classifySitePath: spellings of a page file all land on the page", () => {
  const SPELLINGS: Array<[string, (page: string) => string]> = [
    ["plain", (p) => `/site/${p}.html`],
    ["first letter encoded", (p) => `/site/%${p.charCodeAt(0).toString(16)}${p.slice(1)}.html`],
    [
      "last letter of name encoded",
      (p) => `/site/${p.slice(0, -1)}%${p.charCodeAt(p.length - 1).toString(16)}.html`,
    ],
    ["every letter encoded", (p) => `/site/${enc(p)}.html`],
    ["extension encoded", (p) => `/site/${p}%2ehtml`],
    ["extension dot and letters encoded", (p) => `/site/${p}.%68%74%6d%6c`],
    ["slash encoded", (p) => `/site%2f${p}.html`],
    ["double encoded", (p) => `/site/%25${p.charCodeAt(0).toString(16)}${p.slice(1)}.html`],
    ["triple encoded", (p) => `/site/%2525${p.charCodeAt(0).toString(16)}${p.slice(1)}.html`],
    ["upper case", (p) => `/SITE/${p.toUpperCase()}.HTML`],
    ["mixed case", (p) => `/Site/${p[0]?.toUpperCase()}${p.slice(1)}.Html`],
    ["trailing slash", (p) => `/site/${p}.html/`],
    ["trailing dot", (p) => `/site/${p}.html.`],
    ["trailing dots and slash", (p) => `/site/${p}.html./`],
    ["trailing space encoded", (p) => `/site/${p}.html%20`],
    ["backslash", (p) => `/site${BS}${p}.html`],
    ["encoded backslash", (p) => `/site%5c${p}.html`],
    ["double slash", (p) => `//site//${p}.html`],
    ["dot segment", (p) => `/site/./${p}.html`],
    ["parent segment", (p) => `/site/img/../${p}.html`],
    ["query string", (p) => `/site/${p}.html?utm=1`],
    [
      "encoded letter and query",
      (p) => `/site/%${p.charCodeAt(0).toString(16)}${p.slice(1)}.html?a=b`,
    ],
    ["hash", (p) => `/site/${p}.html#top`],
  ];

  for (const [label, spell] of SPELLINGS) {
    it.each(STATIC_SITE_PAGE_NAMES)(`${label}: %s`, (page) => {
      expect(classifySitePath(spell(page))).toEqual({
        kind: "page",
        page,
        clean: STATIC_SITE_PAGES[page],
      });
    });
  }
});

describe("classifySitePath: what must not redirect", () => {
  it.each([
    "/site/css/site.css",
    "/site/js/site.js",
    "/site/img/brand/logo.svg",
    "/site/fonts/geist.woff2",
    "/site/graphics/rf-graphics.css",
    "/site/analytics.js",
    "/site/pricing",
    "/site/pricing.htm",
    "/site/pricing.html.map",
    "/site/nope.html",
    "/site/img/pricing.html",
    "/site/pricing.html/x",
    "/pricing",
    "/pricing.html",
    "/",
    "/dashboard",
    "/site-page/pricing",
    "/sitepricing.html",
    "/xsite/pricing.html",
    "/site/%2e%2e/pricing.html",
    "/site/pricing.html%3fx",
  ])("%s", (p) => {
    expect(classifySitePath(p).kind).not.toBe("page");
  });

  it("dot-dot segments that stay inside or return to the site folder still name the page", () => {
    expect(classifySitePath("/site/%2e%2e/%2e%2e/site/pricing.html").kind).toBe("page");
    expect(classifySitePath("/other/../site/pricing.html").kind).toBe("page");
  });
});

describe("classifySitePath: a malformed encoding", () => {
  it("that would otherwise name a page is refused as malformed (the middleware answers 400)", () => {
    for (const p of ["/site/%70ricing.html%", "/site/%70ricing%.html", "/%/site/%70ricing.html"]) {
      expect(classifySitePath(p).kind).toBe("malformed");
    }
  });

  it("that names nothing is left alone", () => {
    expect(classifySitePath("/site/css/%zz.css").kind).toBe("none");
    expect(classifySitePath("/dashboard/%").kind).toBe("none");
    expect(classifySitePath("/site/pricing.html%zz").kind).toBe("none");
  });
});

describe("classifySitePath: the list is the route's list", () => {
  it("covers exactly the pages the route serves, home included", () => {
    for (const page of Object.keys(STATIC_SITE_PAGES)) {
      expect(classifySitePath(`/site/${page}.html`).kind).toBe("page");
    }
  });
});

describe("the middleware's import chain", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const imports = (text: string) =>
    [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

  it("site-raw-path.ts reaches only the page list, never the brand package or the page renderer", () => {
    expect(imports(src("site-raw-path.ts"))).toEqual(["@/lib/static-site-pages"]);
  });

  it("the page list is a leaf with no import at all, and static-site-page.ts re-exports the same one", () => {
    expect(imports(src("static-site-pages.ts"))).toEqual([]);
    expect(src("static-site-page.ts")).toMatch(/from "@\/lib\/static-site-pages"/);
  });
});
