/**
 * #2337 route-parity manifest spec (plan §5 R5): "web added a page" becomes a red test instead of
 * silent drift. Every web page (apps/web/app/**\/page.tsx, except the dev-only apps/web/app/dev/**)
 * must have exactly one row in ROUTE_PARITY; every row must still have its page; and every mobile
 * reference must be a real route file under apps/mobile/app.
 */
import { readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { ROUTE_PARITY } from "../lib/route-parity-manifest";

const WEB_APP = join(__dirname, "../../web/app");
const MOBILE_APP = join(__dirname, "../app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Web page directories under apps/web/app ("." for the root page), dev-only pages excluded. */
function webPages(): string[] {
  return walk(WEB_APP)
    .filter((f) => f.endsWith(`${sep}page.tsx`))
    .map((f) => toPosix(relative(WEB_APP, join(f, ".."))) || ".")
    .filter((d) => d !== "dev" && !d.startsWith("dev/"))
    .sort();
}

/** Mobile route refs: route files under apps/mobile/app without ".tsx" (layouts excluded). */
function mobileRoutes(): Set<string> {
  return new Set(
    walk(MOBILE_APP)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => toPosix(relative(MOBILE_APP, f)).replace(/\.tsx$/, ""))
      .filter((r) => !/(^|\/)(_layout|\+html)$/.test(r)),
  );
}

describe("route-parity manifest (#2337)", () => {
  const pages = webPages();
  const rows = Object.keys(ROUTE_PARITY).sort();

  it("finds the web pages (sanity: the walk is not silently empty)", () => {
    expect(pages.length).toBeGreaterThan(100);
  });

  it("every web page has a row: a NEW web page must be mapped, marked web-only, or a gap", () => {
    expect(pages.filter((p) => !(p in ROUTE_PARITY))).toEqual([]);
  });

  it("every row still has its web page (a removed page removes its row)", () => {
    const set = new Set(pages);
    expect(rows.filter((r) => !set.has(r))).toEqual([]);
  });

  it("every mobile reference is a real route file", () => {
    const routes = mobileRoutes();
    const bad: string[] = [];
    for (const [page, row] of Object.entries(ROUTE_PARITY)) {
      if ("mobile" in row) {
        if (row.mobile.length === 0) bad.push(`${page}: empty mobile list`);
        for (const ref of row.mobile) if (!routes.has(ref)) bad.push(`${page} -> ${ref}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every web-only reason and gap note says why", () => {
    const blank = Object.entries(ROUTE_PARITY)
      .filter(
        ([, row]) =>
          ("webOnly" in row && !row.webOnly.trim()) || ("missing" in row && !row.missing.trim()),
      )
      .map(([page]) => page);
    expect(blank).toEqual([]);
  });
});
