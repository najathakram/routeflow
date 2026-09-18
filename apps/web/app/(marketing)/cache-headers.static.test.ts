/**
 * @jest-environment node
 */
// A6 — the marketing site's static, signed-out pages shipped only `s-maxage`
// (App Router's own ISR default), no plain `max-age` — a shared/CDN cache
// could reuse the response but a visitor's own browser had nothing telling
// it to, so every in-session navigation between marketing pages re-fetched
// the HTML. Verified live: `curl -sI https://www.routeflow.info/wholesalers`
// returned `Cache-Control: s-maxage=31536000` and nothing else.
//
// next.config.mjs is deliberately NOT imported in-process here — see
// distributors-redirect.static.test.ts's header comment for why (the
// Jest/Babel `__dirname` collision); the same real-`node`-subprocess
// technique sidesteps it and actually resolves headers().
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const WEB_ROOT = path.resolve(__dirname, "../..");

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

function loadHeaders(): HeaderRule[] {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.headers()));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  return JSON.parse(output);
}

// The exact set of public, signed-out, static marketing routes — every other
// route in this app is either authenticated or reads tenant/session state
// (buyer portal, dashboard, admin, auth), and caching one of those shared
// would leak one visitor's response to the next behind the same CDN edge.
const CACHEABLE_SOURCES = [
  "/",
  "/:path(product|wholesalers|retailers|pricing|company|contact|privacy|terms|sign-in|book-a-demo)",
];
const NEVER_CACHEABLE_SOURCES = [
  "/buyer",
  "/buyer/portal",
  "/dashboard",
  "/login",
  "/signup",
  "/admin",
  "/admin-login",
  "/settings",
];

describe("marketing route Cache-Control — A6", () => {
  const rules = loadHeaders();
  const cacheRules = rules.filter((r) => r.headers.some((h) => h.key === "Cache-Control"));

  it("sets a browser-cacheable Cache-Control (max-age, not just s-maxage) on every public marketing route", () => {
    expect(cacheRules.map((r) => r.source).sort()).toEqual(CACHEABLE_SOURCES.sort());
    for (const rule of cacheRules) {
      const value = rule.headers.find((h) => h.key === "Cache-Control")!.value;
      expect(value).toMatch(/(^|,\s*)max-age=\d+/);
      expect(value).toContain("public");
      expect(value).not.toContain("private");
    }
  });

  it("never matches an authenticated or tenant/session-scoped path (source is a literal path or single-segment alternation, not a wildcard)", () => {
    const matchers = cacheRules.map((r) => {
      // Convert the two known shapes used above into a real RegExp: an exact
      // literal path, or `/:name(a|b|c)` — a single path SEGMENT constrained
      // to a literal alternation (path-to-regexp semantics: no `*`/`+`, so it
      // can never match anything with additional path segments after it).
      if (r.source === "/") return /^\/$/;
      const alt = r.source.match(/^\/:\w+\(([^)]+)\)$/);
      if (!alt) throw new Error(`unexpected Cache-Control source shape: ${r.source}`);
      return new RegExp(`^/(${alt[1]})$`);
    });
    for (const path of NEVER_CACHEABLE_SOURCES) {
      expect(matchers.some((re) => re.test(path))).toBe(false);
    }
  });
});
