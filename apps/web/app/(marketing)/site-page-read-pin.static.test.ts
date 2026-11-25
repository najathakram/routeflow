/**
 * @jest-environment node
 */
// The ready-made pages carry {{brand:key}} tokens, so a test that reads public/site/<page>.html off
// the disk sees the file, not the page. readServedSitePage() (lib/read-site-page.ts) is the one way
// a new test reads a page: it is the route's own function, so a test and the route cannot diverge.
//
// This pin finds every Jest file that reads a ready-made page off the disk by itself (a file read,
// a ".html" name and the public/site folder, with no readServedSitePage import) and fails for any
// that is not on the allow-list. The list is a snapshot of the readers that existed when the seam
// landed: it can only shrink (move a file to readServedSitePage and delete its entry here).
import * as fs from "fs";
import * as path from "path";

const WEB = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".jest-cache", "public"]);
// Jest files, Playwright specs and the e2e helpers (any .ts under e2e/).
const IS_TEST = /\.(test|spec)\.[tj]sx?$/;
const isReader = (rel: string) =>
  IS_TEST.test(rel) || (rel.startsWith("e2e/") && /\.ts$/.test(rel));
const SELF = "app/(marketing)/site-page-read-pin.static.test.ts";

/** Snapshot of the direct readers at the seam's landing, each with the reason it may stay. */
const ALLOWED_DIRECT_READERS: Record<string, string> = {
  "app/(marketing)/old-pages-redirect.static.test.ts": "reads home.html for its redirect links",
  "app/(marketing)/site-anchor-landing.static.test.ts": "anchors and landing page (home, landing)",
  "app/(marketing)/site-auth-nav.static.test.ts": "sign-in links on every page",
  "app/(marketing)/site-brand-seam.static.test.ts": "T35 scans the raw files on purpose",
  "app/(marketing)/site-color-and-life.static.test.ts": "colour and motion pins",
  "app/(marketing)/site-mobile-pass.static.test.ts": "phone layout pins",
  "app/(marketing)/site-motion-always.static.test.ts": "motion pins",
  "app/(marketing)/site-phone-and-motion.static.test.ts": "phone and motion pins",
  "app/(marketing)/site-raw-path-redirect.static.test.ts":
    "must see the raw file to know which pages carry tokens",
  "lib/site-port-tokens.test.ts": "compares the committed raw pages with the script's output",
  // Arrived from master in the catch-up (#4367), after the snapshot; lanes never edit master's guard.
  "app/(marketing)/site-pins.static.test.ts":
    "master's pin guard: the wheel's end-state markup in the raw home.html, byte for byte",
  // Arrived from master in the C1 catch-up (#4393, B1371); lanes never edit master's tests.
  "app/(marketing)/no-login-cutoff-claims.static.test.ts":
    "master's claim scan: reads the raw pages for the login-cutoff wording",
  // Arrived from master in the catch-up (#4474); lanes never edit master's tests.
  "app/(marketing)/site-guarded-phrases.static.test.ts":
    "master's claims guard: scans the raw page sentences against the ledger",
  "app/(marketing)/site-pricing-catalog.static.test.ts":
    "master's price guard: reads the raw price spans and prices.js",
};

// The file-size budget test (replaced by the wheel budget in W1) is matched by its suffix.
const BUDGET_SUFFIX = "-budget.static.test.ts";
const isAllowed = (f: string) => f in ALLOWED_DIRECT_READERS || f.endsWith(BUDGET_SUFFIX);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) testFiles(rel, out);
    } else if (isReader(rel.replace(/^\.\//, ""))) out.push(rel.replace(/^\.\//, ""));
  }
  return out;
}

/** True when a test reads a page off the disk itself. A file that imports readServedSitePage is
 *  still flagged when it calls the raw reader or names a ".html" file inside a file read. */
function readsPagesDirectly(source: string): boolean {
  if (/readSitePageFile/.test(source)) return true;
  // a path built from join(SITE, "<x>.html") and then read
  for (const m of source.matchAll(/(\w+)\s*=\s*(?:path\.)?join\([^)]*\.html["'`]\s*\)/g)) {
    if (new RegExp(String.raw`readFileSync\(\s*${m[1]}\b`).test(source)) return true;
  }
  if (/readFileSync\([^;]*\.html/.test(source)) return true;
  return (
    /readFileSync|readFile\(/.test(source) &&
    /\.html/.test(source) &&
    /public[\/"', ]+site|(?<![\/\w])SITE(?![\/\w])|SITE_ROOT|"site"/.test(source) &&
    !/readServedSitePage/.test(source)
  );
}

describe("site pages are read through readServedSitePage", () => {
  const found = ["app", "components", "lib", "hooks", "e2e"]
    .filter((d) => fs.existsSync(path.join(WEB, d)))
    .flatMap((d) => testFiles(d))
    .filter((f) => f !== SELF)
    .filter((f) => readsPagesDirectly(fs.readFileSync(path.join(WEB, f), "utf8")))
    .sort();

  it("no test outside the allow-list reads public/site/*.html off the disk", () => {
    expect(found.filter((f) => !isAllowed(f))).toEqual([]);
  });

  it("the allow-list only shrinks: every entry still exists and still reads directly", () => {
    const stale = Object.keys(ALLOWED_DIRECT_READERS).filter((f) => !found.includes(f));
    expect(stale).toEqual([]);
    expect(found.some((f) => f.endsWith(BUDGET_SUFFIX))).toBe(true);
  });

  it("the detector also flags the raw reader and a raw .html read beside the seam", () => {
    const seam = `import { readServedSitePage } from "x";`;
    expect(readsPagesDirectly(`${seam} readSitePageFile("home")`)).toBe(true);
    expect(readsPagesDirectly(`${seam} fs.readFileSync(path.join(D, "home.html"), "utf8")`)).toBe(
      true,
    );
  });

  it("the detector follows a path variable built from a .html join into a read", () => {
    const seam = `import { readServedSitePage } from "x";`;
    const code = `${seam} const f = path.join(SITE, "home.html"); fs.readFileSync(f, "utf8");`;
    expect(readsPagesDirectly(code)).toBe(true);
    expect(
      readsPagesDirectly(`${seam} const f = path.join(SITE, "home.html"); fs.existsSync(f);`),
    ).toBe(false);
  });

  it("the detector ignores a /SITE/ URL spelling beside a source read but keeps the SITE variable", () => {
    expect(
      readsPagesDirectly(`fs.readFileSync(path.join(__dirname, "a.ts")); x("/SITE/A.HTML")`),
    ).toBe(false);
    expect(readsPagesDirectly(`fs.readFileSync(path.join(SITE, "x.html"))`)).toBe(true);
    expect(readsPagesDirectly("fs.readFileSync(`${SITE}/x.html`)")).toBe(true);
  });

  it("the detector sees a raw read and ignores one through the seam", () => {
    const raw = `fs.readFileSync(path.join(SITE, "pricing.html"), "utf8")`;
    expect(readsPagesDirectly(raw)).toBe(true);
    expect(readsPagesDirectly(`${raw}; import { readServedSitePage } from "x"`)).toBe(true);
    expect(readsPagesDirectly(`fs.readFileSync(path.join(SITE, "css/site.css"), "utf8")`)).toBe(
      false,
    );
  });
});
