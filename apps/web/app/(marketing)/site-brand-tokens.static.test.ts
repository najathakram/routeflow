/**
 * @jest-environment node
 */
// T14a and T35d: the one place the palette's colours live is the injected `<style id="brand-tokens">`
// (packages/types/brand/palette.json -> `--brand-<key>`). rf-graphics.css names jobs and points them at
// `var(--brand-*)`; no other site stylesheet types a palette value. Read at test time, so a new
// palette needs no edit here.
import * as fs from "fs";
import * as path from "path";
import { loadPalette, paletteCss, validatePalette } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-page";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");
const PALETTE_JSON = path.resolve(WEB, "../../packages/types/brand/palette.json");
const palette = JSON.parse(fs.readFileSync(PALETTE_JSON, "utf8")) as {
  color: Record<string, string>;
};
const COLORS = Object.entries(palette.color);

/** The six digit colour (lower case, no alpha) of a 3, 4, 6 or 8 digit hex, else null. */
function expandHex(digits: string): string | null {
  if (!/^[0-9a-f]+$/i.test(digits)) return null;
  const d = digits.toLowerCase();
  if (d.length === 3 || d.length === 4) return [...d.slice(0, 3)].map((c) => c + c).join("");
  if (d.length === 6 || d.length === 8) return d.slice(0, 6);
  return null;
}

const styleOf = (html: string) =>
  html.match(/<style id="brand-tokens">([\s\S]*?)<\/style>/)?.[1] ?? "";

describe("T14a: the injected palette", () => {
  it("every palette.json colour is in the style text exactly as --brand-<key>:<value>", () => {
    const css = paletteCss(loadPalette());
    expect(COLORS.length).toBeGreaterThan(10);
    for (const [key, value] of COLORS) expect(css).toContain(`--brand-${key}:${value};`);
    expect(css.startsWith(":root{")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
  });

  it("is data driven: another palette gives another block, with no code change", () => {
    const other = validatePalette({ color: { "sea-green": "#102030", night: "#000000" } });
    expect(paletteCss(other)).toBe(":root{--brand-sea-green:#102030;--brand-night:#000000;}");
  });

  it.each([...STATIC_SITE_PAGE_NAMES])(
    "%s is served with exactly one brand-tokens style in <head>",
    (page) => {
      const html = readServedSitePage(page, { websiteId: undefined });
      expect(html.match(/<style id="brand-tokens">/g)).toHaveLength(1);
      const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
      expect(head).toContain('<style id="brand-tokens">');
      const css = styleOf(html);
      for (const [key, value] of COLORS) expect(css).toContain(`--brand-${key}:${value};`);
    },
  );
});

describe("T14a: the contract block of rf-graphics.css", () => {
  const css = read("public/site/graphics/rf-graphics.css");
  const block = css.slice(
    css.indexOf("/*tokens:start*/") + "/*tokens:start*/".length,
    css.indexOf("/*tokens:end*/"),
  );
  const decls = new Map<string, string[]>();
  for (const m of block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/(--rf-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    decls.set(m[1] as string, [...(decls.get(m[1] as string) ?? []), (m[2] as string).trim()]);
  }
  const HEX = /#[0-9a-f]{3,8}\b/i;

  /** Typed values the contract itself lists: they are not in palette.json. */
  const NON_PALETTE: Record<string, string> = {
    "--rf-ink-press": "#04070D",
    "--rf-wh-work": "#E9E4DB",
    "--rf-wh-work-2": "#DCD6CB",
    "--rf-wh-work-wall": "#C2BBAE",
    "--rf-wh-sell": "#1B2638",
    "--rf-wh-sell-2": "#27364C",
    "--rf-wh-sell-wall": "#04070D",
  };
  /** The old names are gone (lane 2.1b-last): nothing typed in the block may be a legacy alias. */
  const LEGACY_TYPED = new Set<string>();

  it("has both markers, in order, once each (tools/build-landing.cjs inlines the block)", () => {
    expect(css.match(/\/\*tokens:start\*\//g)).toHaveLength(1);
    expect(css.match(/\/\*tokens:end\*\//g)).toHaveLength(1);
    expect(css.indexOf("/*tokens:start*/")).toBeLessThan(css.indexOf("/*tokens:end*/"));
  });

  it("every typed colour in the block is a listed non-palette value or a legacy alias", () => {
    const bad: string[] = [];
    for (const [name, values] of decls) {
      for (const value of values) {
        if (!HEX.test(value)) continue;
        if (LEGACY_TYPED.has(name)) continue;
        if (NON_PALETTE[name]?.toLowerCase() === value.toLowerCase()) continue;
        bad.push(`${name}:${value}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no non-palette typed value equals a palette value (that would be a typed palette colour)", () => {
    const palValues = new Set(COLORS.map(([, v]) => v.toLowerCase()));
    for (const v of Object.values(NON_PALETTE)) expect(palValues.has(v.toLowerCase())).toBe(false);
  });

  it("the palette colours and the status tokens read var(--brand-*) of a real palette key", () => {
    const keys = new Set(COLORS.map(([k]) => k));
    const expectVar = (name: string, key: string) =>
      expect(decls.get(name)?.[0]).toBe(`var(--brand-${key})`);
    expectVar("--rf-ink", "ink");
    expectVar("--rf-steel", "steel");
    expectVar("--rf-white", "white");
    expectVar("--rf-bone", "bone");
    expectVar("--rf-line", "line");
    expectVar("--rf-copper", "copper");
    expectVar("--rf-copper-light", "copper-light");
    expectVar("--rf-copper-dark", "copper-dark");
    expectVar("--rf-paid-bg", "paid-bg");
    expectVar("--rf-paid", "paid-text");
    expectVar("--rf-pending-bg", "pending-bg");
    expectVar("--rf-pending", "pending-text");
    expectVar("--rf-overdue-bg", "overdue-bg");
    expectVar("--rf-overdue", "overdue-text");
    for (const m of block.matchAll(/var\(--brand-([a-z0-9-]+)\)/g)) {
      expect(keys.has(m[1] as string)).toBe(true);
    }
  });

  it("the job tokens exist and point at the palette colours", () => {
    const jobs: Record<string, string> = {
      "--rf-text": "var(--rf-ink)",
      "--rf-text-2": "var(--rf-steel)",
      "--rf-btn": "var(--rf-ink)",
      "--rf-btn-press": "var(--rf-ink-press)",
      "--rf-btn-fg": "var(--rf-white)",
      "--rf-panel": "var(--rf-ink)",
      "--rf-on-panel": "var(--rf-white)",
      "--rf-on-panel-2": "var(--rf-bone)",
      "--rf-soft": "var(--rf-bone)",
      "--rf-link": "var(--rf-copper-dark)",
      "--rf-link-on-panel": "var(--rf-copper-light)",
      "--rf-focus": "var(--rf-accent)",
      "--rf-accent": "var(--rf-copper)",
      "--rf-accent-on-panel": "var(--rf-copper-light)",
      "--rf-ring": "0 0 0 1px var(--rf-line)",
    };
    for (const [name, value] of Object.entries(jobs)) expect(decls.get(name)?.[0]).toBe(value);
    for (const name of ["--rf-wh-work", "--rf-wh-sell", "--rf-wh-focus", "--rf-wh-focus-wall"]) {
      expect(decls.has(name)).toBe(true);
    }
  });

  it("keeps the type scale, corner and font lines as they were", () => {
    expect(block).toContain(
      '--rf-font:"Geist","Geist Fallback",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    );
    expect(block).toContain("--rf-h1:clamp(44px,5vw,72px);--rf-h1-tr:-.04em;");
    expect(block).toContain(
      "--rf-r-stage:32px;--rf-r-card:24px;--rf-r-inner:18px;--rf-r-tile:12px;",
    );
  });

  it("names no brand in a comment or anywhere in the file (exemption row lifted)", () => {
    expect(css).not.toMatch(/route\s?flow|rovio|xrov/i);
  });
});

describe("T35d: no palette value typed outside the injected style", () => {
  /** Stylesheets still typing palette values, the lane that repaints each and its wave. Data, not
   *  logic: the listed values must be EXACTLY what the file holds, so a lane that cleans a file (or
   *  part of it) must edit its row, and a new typed value fails. rf-graphics.css has no row. */
  const EXEMPT_T35D: Array<{ file: string; hexes: string[]; lane: string; wave: string }> = [];

  const cssFiles = (dir: string, deep: boolean): string[] => {
    const abs = path.join(WEB, dir);
    const out: string[] = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (deep) out.push(...cssFiles(rel, true));
      } else if (e.name.endsWith(".css")) out.push(rel);
    }
    return out;
  };
  const FILES = [...cssFiles("public/site", true), "components/site-frame/site-frame.css"];

  const PALETTE_RGB = new Map(
    COLORS.map(([, v]) => [v.slice(1, 7).toLowerCase(), v.toUpperCase()]),
  );
  /** Every palette colour a stylesheet types, in any spelling: #fff, #fffa (short, with alpha),
   *  #FFFFFF, #ffffff1a (long, with alpha) all count as the palette value they start with. */
  const paletteHexesIn = (text: string): string[] => {
    const found = new Set<string>();
    for (const m of text.matchAll(/#([0-9a-f]+)(?![0-9a-f])/gi)) {
      const rgb = expandHex(m[1] as string);
      const key = rgb && PALETTE_RGB.get(rgb);
      if (key) found.add(key);
    }
    return [...found].sort();
  };

  it("expandHex reads 3, 4, 6 and 8 digit colours as their six digit colour, and nothing else", () => {
    expect(expandHex("fff")).toBe("ffffff");
    expect(expandHex("FFFA")).toBe("ffffff");
    expect(expandHex("0e1726")).toBe("0e1726");
    expect(expandHex("0E172680")).toBe("0e1726");
    expect(expandHex("abc")).toBe("aabbcc");
    for (const bad of ["", "ff", "fffff", "fffffff", "ggg", "fffffffff"]) {
      expect(expandHex(bad)).toBeNull();
    }
  });

  it("paletteHexesIn sees short, long and alpha spellings of a palette colour", () => {
    expect(paletteHexesIn("a{color:#fff}b{color:#FFFFFF}c{color:#fffa}d{color:#ffffff1a}")).toEqual(
      ["#FFFFFF"],
    );
    expect(paletteHexesIn("a{color:#0e1726}b{color:#B5683A80}c{color:#123}")).toEqual([
      "#0E1726",
      "#B5683A",
    ]);
    expect(paletteHexesIn("a{color:#112233}#main{}")).toEqual([]);
  });

  it("the scan covers the site css and the frame css (app/(marketing) holds no stylesheet any more)", () => {
    expect(FILES).toContain("public/site/graphics/rf-graphics.css");
    expect(FILES).toContain("components/site-frame/site-frame.css");
    expect(cssFiles("app/(marketing)", false)).toEqual([]);
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FILES)(
    "%s types exactly the palette values its row lists (none without a row)",
    (file) => {
      const row = EXEMPT_T35D.find((e) => e.file === file);
      expect(paletteHexesIn(read(file))).toEqual([...(row?.hexes ?? [])].sort());
    },
  );

  it("every row names a scanned file, once, with a lane and a wave", () => {
    const files = EXEMPT_T35D.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    for (const row of EXEMPT_T35D) {
      expect(FILES).toContain(row.file);
      expect(row.hexes.length).toBeGreaterThan(0);
      expect(row.lane).toMatch(/\S/);
      expect(row.wave).toMatch(/^W\d/);
    }
  });

  /** Colours typed as %23rrggbb inside a url() (a data-URI cannot read a variable). */
  const uriHexesIn = (text: string): string[] => {
    const found: string[] = [];
    for (const u of text.matchAll(/url\(([^)]*)\)/g)) {
      for (const m of (u[1] as string).matchAll(/%23([0-9a-f]+)(?![0-9a-f])/gi)) {
        found.push(`#${(m[1] as string).toLowerCase()}`);
      }
    }
    return found;
  };

  it("uriHexesIn decodes %23 hex inside url() only", () => {
    expect(uriHexesIn('a{b:url("data:x,%3Ccircle stroke=%27%234caed9%27/%3E")}')).toEqual([
      "#4caed9",
    ]);
    expect(uriHexesIn("a{content:'%23123456'}")).toEqual([]);
  });

  it.each(FILES)("%s: every colour typed as %%23hex inside a url() is a palette value", (file) => {
    const strays = uriHexesIn(read(file)).filter((h) => {
      const key = expandHex(h.slice(1));
      return !key || !PALETTE_RGB.has(key);
    });
    expect(strays).toEqual([]);
  });

  it("the scan finds the data-URI colours it is there for (mobile.css holds three)", () => {
    expect(uriHexesIn(read("public/site/css/mobile.css")).length).toBeGreaterThanOrEqual(3);
  });

  it("rf-graphics.css and the share image route are clean outright", () => {
    expect(paletteHexesIn(read("public/site/graphics/rf-graphics.css"))).toEqual([]);
    expect(paletteHexesIn(read("app/(marketing)/opengraph-image/route.tsx"))).toEqual([]);
    expect(EXEMPT_T35D.some((e) => e.file.endsWith("rf-graphics.css"))).toBe(false);
    expect(read("app/(marketing)/opengraph-image/route.tsx")).not.toMatch(
      /#[0-9a-f]{3,8}(?![0-9a-f])/i,
    );
  });
});
