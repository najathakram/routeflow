/**
 * @jest-environment node
 */
// SA-1196 K1/A1/A3: the page chrome (analytics hook, header shadow, phone menu, phones header pill) lives in one file, js/chrome.js, loaded once by the nine chrome pages (landing takes none). No other script
// keeps a copy. The tokens are read from chrome.js itself. Every scan asserts it found its targets (L-202).
import * as fs from "fs";
import * as path from "path";
import { JSDOM } from "jsdom";
import { SCRIPT_GZIP_KB } from "../../e2e/helpers/site-speed-budget";
import { readServedSitePage } from "@/lib/read-site-page";
import {
  ANALYTICS_SRC,
  FIRST_TOUCH_SRC,
  STATIC_SITE_PAGE_NAMES,
  type StaticSitePage,
} from "@/lib/static-site-page";

const WEB = path.resolve(__dirname, "../..");
const SITE = path.join(WEB, "public/site");
const JS = path.join(SITE, "js");

// The page list is the served-page list; the directory listing must agree with it, so a missing or an extra file fails.
const pages = STATIC_SITE_PAGE_NAMES.map((p) => `${p}.html`);
// The page as the route serves it (no visit-count site ID), read through the one seam.
const html = (page: string) =>
  readServedSitePage(page.replace(/\.html$/, "") as StaticSitePage, { websiteId: undefined });
// Scripts the renderer adds to every served page; the speed budget counts them apart from a page's own scripts.
const RENDERER_SCRIPTS: string[] = [FIRST_TOUCH_SRC, ANALYTICS_SRC];
// The src is read through the DOM, so any quoting (double, single, none) is seen (SA-1200 A1 L2).
const ownScriptSrcs = (page: string) =>
  Array.from(new JSDOM(html(page)).window.document.querySelectorAll("script[src]"))
    .map((el) => el.getAttribute("src") as string)
    .filter((src) => !RENDERER_SCRIPTS.includes(src));
// A page whose script budget is 0 (SA-1187 K1: landing links no script of its own) takes no chrome.js (SA-1196 A2).
// The exemption is read from that budget row, never typed as a second list.
const noScriptPages = pages.filter(
  (f) => SCRIPT_GZIP_KB[f.replace(/\.html$/, "") as keyof typeof SCRIPT_GZIP_KB] === 0,
);
const chromePages = pages.filter((f) => !noScriptPages.includes(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const chrome = () => fs.readFileSync(path.join(JS, "chrome.js"), "utf8");

/** The class names chrome.js puts on elements through classList, read from its code. */
function chromeTokens(): string[] {
  const src = strip(chrome());
  const found = new Set<string>();
  for (const m of src.matchAll(/classList\.(?:toggle|add|remove)\(\s*(["'])([\w-]+)\1/g)) {
    found.add(m[2] as string);
  }
  return [...found];
}

const GENERIC = new Set(["open"]);

describe("chrome.js is the one home of the page chrome", () => {
  it("finds the ten ready-made pages", () => {
    expect(pages.length).toBe(10);
    const onDisk = fs
      .readdirSync(SITE)
      .filter((f) => f.endsWith(".html"))
      .sort();
    expect(onDisk).toEqual([...pages].sort());
  });

  it("every chrome page loads /site/js/chrome.js exactly once, and a no-script page loads no script", () => {
    expect(chromePages.length).toBe(9);
    expect(noScriptPages).toEqual(["landing.html"]);
    for (const page of chromePages) {
      // Through the DOM, so a second tag with other quoting is counted too (SA-1200 A1 L2).
      const tags = Array.from(
        new JSDOM(html(page)).window.document.querySelectorAll("script[src]"),
      ).filter((el) => el.getAttribute("src") === "/site/js/chrome.js");
      expect({ page, tags: tags.length }).toEqual({ page, tags: 1 });
    }
    for (const page of noScriptPages) {
      // "no script of its own": the renderer's first-touch and visit-count scripts are not the page's.
      expect({ page, own: ownScriptSrcs(page) }).toEqual({ page, own: [] });
    }
  });

  it("chrome.js runs before site.js and home-up.js where a page has them", () => {
    let ordered = 0;
    for (const page of chromePages) {
      const at = html(page).indexOf("/site/js/chrome.js");
      for (const later of ["/site/js/site.js", "/site/js/home-up.js"]) {
        const i = html(page).indexOf(later);
        if (i < 0) continue;
        expect({ page, found: at >= 0 }).toEqual({ page, found: true });
        ordered++;
        expect({ page, later, before: at < i }).toEqual({ page, later, before: true });
      }
    }
    expect(ordered).toBe(9);
  });

  it("the tokens are found in chrome.js, and no other script keeps them", () => {
    const tokens = chromeTokens();
    // the pill, the header shadow and the menu toggles
    for (const t of ["hero-btn-in", "scrolled", "open", "menu-open"]) expect(tokens).toContain(t);
    const others = fs.readdirSync(JS).filter((f) => f.endsWith(".js") && f !== "chrome.js");
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      const src = strip(fs.readFileSync(path.join(JS, file), "utf8"));
      for (const t of tokens) {
        // Named exemption: "open" is a plain word other motion blocks toggle on their own elements
        // (use-case and founder cards). The menu it serves is keyed by selector below.
        if (GENERIC.has(t)) continue;
        const re = new RegExp(String.raw`classList\.(?:toggle|add|remove)\(\s*["']${t}["']`);
        expect({ file, token: t, has: re.test(src) }).toEqual({ file, token: t, has: false });
      }
      // the analytics hook and the menu/CTA hooks are chrome too
      expect({ file, hook: /\[data-track\]/.test(src) }).toEqual({ file, hook: false });
      expect({ file, menu: /["']#mobile-menu["']/.test(src) }).toEqual({ file, menu: false });
      expect({ file, menuBtn: /["'].menu-btn["']/.test(src) }).toEqual({ file, menuBtn: false });
    }
  });

  it("the header on-dark observer is the one named exception: only home-up.js, one observer block", () => {
    // It is home-only chrome (its selector matches only the home page). Keyed by file and token, not by
    // line: it sits near the header block of home-up.js (home-up.js:61-69 at d1b0b95ef7).
    const holders: string[] = [];
    for (const f of fs.readdirSync(JS).filter((x) => x.endsWith(".js"))) {
      const src = strip(fs.readFileSync(path.join(JS, f), "utf8"));
      if (/["']on-dark["']/.test(src)) holders.push(f);
    }
    expect(holders).toEqual(["home-up.js"]);
    const home = strip(fs.readFileSync(path.join(JS, "home-up.js"), "utf8"));
    expect(home.match(/["']on-dark["']/g)?.length).toBe(1);
    expect(home.match(/new IntersectionObserver\([^]*?["']on-dark["']/g)?.length).toBe(1);
  });

  it("the analytics hook sends {event, where, page}", () => {
    const src = strip(chrome());
    expect(src).toMatch(/\[data-track\]/);
    expect(src).toMatch(/data-where/);
    expect(src).toMatch(/page:\s*location\.pathname/);
  });

  it("every chrome block is guarded on its element being present", () => {
    const src = strip(chrome());
    // each block reads its element, then runs only when it is there
    expect(src).toMatch(/var header = \$\("\.site-header"\);\s*if \(header\)/);
    expect(src).toMatch(
      /btn = \$\("\.menu-btn"\),\s*menu = \$\("#mobile-menu"\);\s*if \(btn && menu\)/,
    );
    expect(src).toMatch(/if \(!head\) return;/);
    expect(src).toContain("IntersectionObserver");
    // the root selectors are read from chrome.js (every one-argument $("...") or $$("...") lookup, and every
    // document.querySelector / querySelectorAll call with a string literal), never typed here.
    // One with no element on any chrome page is dead code.
    const lookup = /(?:\$\$?|querySelector(?:All)?)\(\s*(["'])((?:(?!\1).)+)\1\s*\)/g;
    const roots = [...new Set([...src.matchAll(lookup)].map((m) => m[2] as string))];
    expect(roots).toEqual(expect.arrayContaining([".site-header", ".menu-btn", "#mobile-menu"]));
    // the lookup finds a planted direct call, so the scan cannot go quiet by missing a style of call
    const planted = [
      ...`document.querySelector(".x"); document.querySelectorAll('.y'); $("z", r)`.matchAll(
        lookup,
      ),
    ].map((m) => m[2]);
    expect(planted).toEqual([".x", ".y"]);
    const docs = chromePages.map((page) => new JSDOM(html(page)).window.document);
    expect(docs.length).toBe(9);
    for (const root of roots) {
      const hits = docs.filter((d) => d.querySelector(root)).length;
      expect({ root, hits: hits > 0 }).toEqual({ root, hits: true });
    }
  });
});

// SA-1199 P5 / SA-1200 A1 L4: no typed header height. The header's height is read live (chrome.js) and the test reads
// the live nav rect; a literal copy of the header rule's height (with or without px, and N.0px or N.5px too) or a
// literal rootMargin in those files is a typed header size. The number comes from the header rule in site.css.
describe("no typed header height (SA-1199 P5)", () => {
  const siteCss = fs.readFileSync(path.join(SITE, "css/site.css"), "utf8");
  const headerHeights = [
    ...new Set(
      [...siteCss.matchAll(/(?:^|[}\s,])(?:\.site-header )?\.nav\{([^}]*)\}/g)]
        .map((m) => (m[1] as string).match(/(?:^|;)height:(\d+)(?:\.\d+)?px/)?.[1])
        .filter((n): n is string => !!n),
    ),
  ];
  it("finds the header rule's height in site.css (a pin that found nothing would pass on anything)", () => {
    expect(headerHeights.length).toBeGreaterThan(0);
  });
  const H = headerHeights[0] as string;
  // SA-1196 A4-1 also forbids a typed 56, the pill's bottom edge inside the header; it is not a header rule, so it is
  // named here, not derived.
  const PILL_BOTTOM = "56";
  const TYPED = new RegExp(
    `(?<![\\w.])-?(?:${[...headerHeights, PILL_BOTTOM].join("|")})(?:\\.\\d+)?(?:px)?(?![\\w.])` +
      `|rootMargin\\s*:\\s*["'\`]\\s*-?\\d`,
  );
  const typedHits = (src: string) =>
    strip(src)
      .split("\n")
      .filter((l) => TYPED.test(l));
  const FILES = [
    path.join(JS, "chrome.js"),
    path.join(WEB, "e2e/93-site-w3-header.spec.ts"),
    path.join(WEB, "e2e/helpers/header-pill.ts"),
  ];

  it("self-check: a planted typed rootMargin and a typed 56 are caught", () => {
    expect(typedHits('{ rootMargin: "-68px 0px 0px 0px" },')).toHaveLength(1);
    expect(typedHits(`const headerH = ${H};`)).toHaveLength(1);
    expect(typedHits(`const headerH = "${H}.0px";`)).toHaveLength(1);
    expect(typedHits(`const headerH = "${H}.5px";`)).toHaveLength(1);
    expect(typedHits("if (r.bottom <= 56) return;")).toHaveLength(1);
    expect(typedHits('{ rootMargin: "-" + headH + "px 0px 0px 0px" },')).toHaveLength(0);
    expect(typedHits(`viewport 1${H} and 0.${H} and x1${H}`)).toHaveLength(0);
  });

  it("chrome.js, spec 93 and the pill helper type no header height, and chrome.js reads it live", () => {
    for (const f of FILES) {
      expect({ f: path.basename(f), hits: typedHits(fs.readFileSync(f, "utf8")) }).toEqual({
        f: path.basename(f),
        hits: [],
      });
    }
    expect(strip(chrome())).toMatch(/head\.getBoundingClientRect\(\)\.height/);
    expect(strip(chrome())).toMatch(/rootMargin:\s*"-"\s*\+\s*headH/);
  });
});

describe("the sync script copies every script and stylesheet under public/site", () => {
  const script = fs.readFileSync(path.resolve(WEB, "../../scripts/sync-site-port.mjs"), "utf8");
  // Named exemptions: files that are not copied from the design source.
  const EXEMPT = new Set<string>([
    // written in this repo and injected when the page is served (lib/static-site-page.ts); not in the design source
    "js/first-touch.js",
  ]);
  const walk = (dir: string, base: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`],
      );

  it("js/ and css/ files are in the copy list", () => {
    const files = [...walk(JS, "js/"), ...walk(path.join(SITE, "css"), "css/")];
    expect(files.length).toBeGreaterThan(10);
    // the string entries of the copy-list array only: a name in a comment or elsewhere does not count
    const list = /for \(const rel of \[([^\]]*)\]/.exec(script)?.[1] ?? "";
    const listed = new Set(
      list
        .split("\n")
        .map((l) => /^\s*"([^"]+)",?\s*(?:\/\/.*)?$/.exec(l)?.[1])
        .filter((x): x is string => !!x),
    );
    expect(listed.size).toBeGreaterThan(10);
    const missing = files.filter((f) => !EXEMPT.has(f) && !listed.has(f));
    expect(missing).toEqual([]);
  });
});
