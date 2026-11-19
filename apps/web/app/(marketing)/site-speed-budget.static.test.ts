/**
 * @jest-environment node
 */
// T43 (spec-delta 2026-11-14 section 4): the weight budget of the public site, no browser. Each page
// is read through readServedSitePage() (the route's own function); the css, js, image and font files
// it links are read from public/site and gzipped with zlib. Budgets: e2e/helpers/site-speed-budget.ts.
//
// Rules that already hold are plain tests. Rules the site does not meet yet are `test.failing` and
// named in PENDING_WAVE (rule + page, wave package, reason): the file is green today and goes red by
// design the moment a budget is met (a failing test that passes fails the run), so the lane that
// clears it must delete the PENDING_WAVE row. A row for a rule that is not pending is a stale marker.
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES, type StaticSitePage } from "@/lib/static-site-page";
import {
  FONT_GZIP_KB,
  GZIP_TOTAL_KB,
  HTML_GZIP_KB,
  RASTER_ICON_GZIP_KB,
  SCRIPT_GZIP_KB,
} from "../../e2e/helpers/site-speed-budget";

const PUBLIC_DIR = path.resolve(__dirname, "../../public");

/** Rules not met yet. Key: `<rule>:<page>`. The wave package that clears it is named in `wave`. */
const PENDING_WAVE: Record<string, { wave: string; reason: string }> = {
  ...Object.fromEntries(
    STATIC_SITE_PAGE_NAMES.map((p): [string, { wave: string; reason: string }] => [
      `logo-svg:${p}`,
      {
        wave: "W4 2.5",
        reason: "the logo (and on home the symbol and end-mark) is still a png; becomes SVG",
      },
    ]),
  ),
  ...Object.fromEntries(
    ["getting-started", "does-and-doesnt", "data-in-and-out", "security", "company", "contact"].map(
      (p): [string, { wave: string; reason: string }] => [
        `prices-js-only-with-plans:${p}`,
        { wave: "W3 2.3-inner", reason: "prices.js is loaded but the page has no [data-plan]" },
      ],
    ),
  ),
};

const kb = (bytes: number): number => bytes / 1024;
const gz = (data: Buffer | string): number => zlib.gzipSync(data).length;

function readPublic(url: string): Buffer | null {
  const file = path.join(PUBLIC_DIR, url.split(/[?#]/)[0].replace(/^\//, ""));
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

interface PageWeight {
  html: string;
  htmlGz: number;
  scripts: string[];
  styles: string[];
  images: string[];
  fonts: string[];
  scriptGz: number;
  totalGz: number;
  gzOf: (url: string) => number;
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * The local files a page links, attribute order does not matter. A local url that is not under /site/
 * (and not external, data: or a fragment) throws instead of being skipped, so a file can never drop
 * out of the weight silently.
 */
function linkedFiles(html: string, page: string) {
  const out = {
    scripts: new Set<string>(),
    styles: new Set<string>(),
    images: new Set<string>(),
    preloaded: new Set<string>(),
  };
  const take = (url: string | undefined, into: Set<string>): void => {
    if (!url || /^(https?:)?\/\/|^(data|mailto|tel|javascript):|^#/.test(url)) return;
    if (!url.startsWith("/site/"))
      throw new Error(`${page}: linked file ${url} is not under /site/`);
    into.add(url);
  };
  for (const [tag] of html.matchAll(/<(?:script|img|link)\b[^>]*>/g)) {
    if (tag.startsWith("<script")) take(attr(tag, "src"), out.scripts);
    else if (tag.startsWith("<img")) take(attr(tag, "src"), out.images);
    else {
      const rel = attr(tag, "rel") ?? "";
      const href = attr(tag, "href");
      if (/\bstylesheet\b/.test(rel)) take(href, out.styles);
      else if (/\b(preload|icon)\b/.test(rel) && href && /\.woff2$/.test(href)) {
        take(href, out.preloaded);
      }
    }
  }
  return {
    scripts: [...out.scripts],
    styles: [...out.styles],
    images: [...out.images],
    preloaded: [...out.preloaded],
  };
}

function weigh(page: StaticSitePage): PageWeight {
  const html = readServedSitePage(page, { websiteId: undefined });
  const { scripts, styles, images, preloaded } = linkedFiles(html, page);
  // @font-face urls inside the linked stylesheets (relative to the stylesheet's own folder).
  const cssFonts = styles.flatMap((css) => {
    const text = readPublic(css)?.toString("utf8") ?? "";
    return [...text.matchAll(/url\(["']?([^"')]+\.woff2)/g)].map((m) =>
      path.posix.normalize(path.posix.join(path.posix.dirname(css), m[1])),
    );
  });
  const fonts = [...new Set([...preloaded, ...cssFonts])];
  const gzOf = (url: string): number => {
    const data = readPublic(url);
    if (!data) throw new Error(`${page}: linked file ${url} is not under public/`);
    return gz(data);
  };
  const sum = (urls: string[]): number => urls.reduce((n, u) => n + gzOf(u), 0);
  const htmlGz = gz(html);
  const scriptGz = sum(scripts);
  return {
    html,
    htmlGz,
    scripts,
    styles,
    images,
    fonts,
    scriptGz,
    totalGz: htmlGz + scriptGz + sum(styles) + sum(images) + sum(fonts),
    gzOf,
  };
}

/** A plain test, or `test.failing` while the rule is in PENDING_WAVE. */
const USED_RULE_KEYS = new Set<string>();
function rule(ruleId: string, page: StaticSitePage, title: string, body: () => void): void {
  USED_RULE_KEYS.add(`${ruleId}:${page}`);
  const pending = PENDING_WAVE[`${ruleId}:${page}`];
  if (pending) test.failing(`${title} [pending ${pending.wave}: ${pending.reason}]`, body);
  else test(title, body);
}

const weights = new Map<StaticSitePage, PageWeight>(
  STATIC_SITE_PAGE_NAMES.map((p) => [p, weigh(p)]),
);

describe("T43 site weight budget (gzip)", () => {
  test("finds the ten pages and their linked files", () => {
    expect(STATIC_SITE_PAGE_NAMES).toHaveLength(10);
    expect(weights.get("home")?.scripts.length).toBeGreaterThan(3);
  });

  test("linkedFiles reads any attribute order and refuses a local file outside /site/", () => {
    const snippet =
      '<link href="/site/css/a.css" rel="stylesheet"><script defer src="/site/js/a.js"></script>' +
      '<img width="1" src="/site/img/a.png" height="1"><link href="https://x.test/a.css" rel="stylesheet">';
    expect(linkedFiles(snippet, "t")).toEqual({
      scripts: ["/site/js/a.js"],
      styles: ["/site/css/a.css"],
      images: ["/site/img/a.png"],
      preloaded: [],
    });
    expect(() => linkedFiles('<script src="/static/a.js"></script>', "t")).toThrow(
      /not under \/site/,
    );
  });

  // Registered last: the rules above run rule() while the file is collected, so the set is full by now.
  test("every PENDING_WAVE key is a rule that exists (a misspelled id fails)", () => {
    const unused = Object.keys(PENDING_WAVE).filter((k) => !USED_RULE_KEYS.has(k));
    expect(unused).toEqual([]);
  });

  for (const page of STATIC_SITE_PAGE_NAMES) {
    const w = weights.get(page)!;
    const kind = page === "home" ? "home" : page === "landing" ? "landing" : "inner";

    describe(page, () => {
      rule(
        page === "home" ? "home-total" : "total",
        page,
        `${page}: total gzip <= ${GZIP_TOTAL_KB[kind]} KB`,
        () => {
          expect(kb(w.totalGz)).toBeLessThanOrEqual(GZIP_TOTAL_KB[kind]);
        },
      );

      rule("html", page, `${page}: html gzip <= ${HTML_GZIP_KB} KB`, () => {
        expect(kb(w.htmlGz)).toBeLessThanOrEqual(HTML_GZIP_KB);
      });

      if (kind !== "landing") {
        const cap = SCRIPT_GZIP_KB[kind];
        rule("scripts", page, `${page}: script gzip <= ${cap} KB`, () => {
          expect(kb(w.scriptGz)).toBeLessThanOrEqual(cap);
        });
      }

      rule("img-size", page, `${page}: every img has width and height`, () => {
        // a <template> image is only a decode source for the wheel hub, never laid out
        const laidOut = w.html.replace(/<template[\s\S]*?<\/template>/g, "");
        const bad = [...laidOut.matchAll(/<img\b[^>]*>/g)]
          .map((m) => m[0])
          .filter((tag) => !/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag));
        expect(bad).toEqual([]);
      });

      rule(
        "raster-icons",
        page,
        `${page}: each raster icon gzip <= ${RASTER_ICON_GZIP_KB} KB`,
        () => {
          const big = w.images
            .filter((u) => /\.(png|jpe?g|webp|gif)$/i.test(u))
            .filter((u) => kb(w.gzOf(u)) > RASTER_ICON_GZIP_KB);
          expect(big).toEqual([]);
        },
      );

      rule("logo-svg", page, `${page}: logo, symbol and end-mark are SVG, not png`, () => {
        const raster = w.images.filter((u) => /\.png$/i.test(u));
        expect(raster).toEqual([]);
      });

      rule(
        "font",
        page,
        `${page}: one Geist woff2, preloaded, swap, gzip <= ${FONT_GZIP_KB} KB`,
        () => {
          expect(w.fonts).toHaveLength(1);
          expect(w.html).toMatch(/<link\b[^>]*rel="preload"[^>]*\.woff2/);
          expect(kb(w.gzOf(w.fonts[0]))).toBeLessThanOrEqual(FONT_GZIP_KB);
        },
      );

      rule("font-swap", page, `${page}: the Geist @font-face uses font-display: swap`, () => {
        // landing carries its css inline, so the @font-face may sit in the html itself.
        const sheets = [w.html, ...w.styles.map((u) => readPublic(u)?.toString("utf8") ?? "")].join(
          "\n",
        );
        expect(sheets).toMatch(/@font-face\{[^}]*font-display:swap/);
      });

      rule(
        "prices-js-only-with-plans",
        page,
        `${page}: prices.js only where [data-plan] exists`,
        () => {
          const loadsPrices = w.scripts.some((u) => /\/prices\.js$/.test(u));
          const hasPlans = /\sdata-plan\b/.test(w.html);
          expect(loadsPrices && !hasPlans).toBe(false);
        },
      );
    });
  }
});
