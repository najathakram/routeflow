/**
 * @jest-environment node
 */
// middleware.ts guards the raw file address of every ready-made page (see lib/site-raw-path.ts):
// any spelling of /site/<page>.html answers 307 to the clean address with the query kept; a broken
// escape that hides such a name answers 400; everything else under /site/ goes on untouched.
import { NextRequest } from "next/server";
import { config, middleware } from "../middleware";
import { STATIC_SITE_PAGE_NAMES, STATIC_SITE_PAGES } from "./static-site-page";

const call = (path: string) => middleware(new NextRequest(`http://localhost:3001${path}`));

describe("middleware: raw page files", () => {
  it("the matcher runs for /site/ paths", () => {
    const [pattern] = config.matcher;
    const re = new RegExp(`^${pattern}$`);
    expect(re.test("/site/pricing.html")).toBe(true);
    expect(re.test("/site/%70ricing.html")).toBe(true);
    expect(re.test("/site/css/site.css")).toBe(true);
  });

  it.each(STATIC_SITE_PAGE_NAMES)(
    "%s: an encoded spelling redirects 307 to the clean address",
    (page) => {
      const encoded = `/site/%${page.charCodeAt(0).toString(16)}${page.slice(1)}.html`;
      const res = call(encoded);
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location") as string);
      expect(location.pathname).toBe(STATIC_SITE_PAGES[page]);
      expect(location.origin).toBe("http://localhost:3001");
    },
  );

  it("keeps the query string", () => {
    const res = call("/site/%70ricing.html?plan=growth&x=1");
    const location = new URL(res.headers.get("location") as string);
    expect(res.status).toBe(307);
    expect(location.pathname).toBe("/pricing");
    expect(location.search).toBe("?plan=growth&x=1");
  });

  it("double-encoded, upper case and trailing-dot spellings redirect too", () => {
    for (const p of ["/site/%2570ricing.html", "/SITE/PRICING.HTML", "/site/pricing.html."]) {
      expect(call(p).status).toBe(307);
    }
  });

  it("a malformed escape that hides a page name is a 400, not the raw file", () => {
    expect(call("/site/%70ricing.html%").status).toBe(400);
  });

  it("assets under /site/ and other paths are not redirected", () => {
    for (const p of [
      "/site/css/site.css",
      "/site/js/site.js",
      "/site/img/brand/x.svg",
      "/pricing",
    ]) {
      const res = call(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});
