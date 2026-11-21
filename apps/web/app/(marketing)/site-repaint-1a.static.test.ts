/**
 * @jest-environment node
 */
// Repaint, lane 2.1a: the seven files of this lane carry no retired token (T14b, scoped), no gradient, blur,
// glow or shadow other than the one-pixel ring (T18a, scoped), no typed colour, and every band resolves to
// white, bone or ink (T15, static form). Files that other lanes still own are DATA rows with their lane and
// wave: each later lane deletes its row as it cleans, and a row for a file that is already clean fails.
import { JSDOM } from "jsdom";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { closestIllustration } from "../../e2e/helpers/site-figure-scope";
import { readServedSitePage } from "@/lib/read-site-page";
import { brandTokensTag, STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-page";
import { loadPalette } from "@routeflow/types/brand";
import { KNOWN_AT_RULES, readCss, readStyleAttr, type CssRule } from "./site-css-rules";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const MINE = [
  "public/site/css/home-color.css",
  "public/site/css/color-deep.css",
  "public/site/css/product.css",
  "public/site/css/company.css",
  "public/site/css/does.css",
  "public/site/css/start.css",
  "components/site-frame/site-frame.css",
];

const allSiteCss = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".css")) out.push(rel);
    }
  };
  walk("public/site");
  out.push("components/site-frame/site-frame.css");
  return out;
};

// The names the ux-spec retires (section 3), as references or definitions.
const RETIRED =
  /(?<![\w-])--(?:rf-brand-\d+|rf-on-navy|rf-link-on-navy|rf-tint|rf-ink-[23]|rf-sun(?:-soft)?|rf-coral(?:-soft)?|rf-mint(?:-soft)?|rf-ok|rf-sh-(?:card|sample|win)|pc-[a-z]+|fld-[a-z]+|k-(?:bg|ink|dot)|navy(?:-d)?|sun|tint)(?![\w-])/g;
// Aliases that site.css points at retired names. This lane's files avoid them too (jobs only).
const ALIASES =
  /(?<![\w-])--(?:ink-[23]|b(?:50|300|500|600|700|800)|sun-t|coral(?:-t)?|sky(?:-t)?)(?![\w-])/g;

const refs = (file: string, re: RegExp) => [...new Set(stripComments(read(file)).match(re) ?? [])];

// Files outside this lane that still reference a retired name today (scanned 2026-11-14).
const T14B_ROWS: Array<{ file: string; lane: string; wave: string }> = [];

// Files outside this lane that still hold a gradient, blur, glow or non-ring shadow today.
const T18A_ROWS: Array<{ file: string; lane: string; wave: string }> = [];

const flatOffences = (file: string): string[] => {
  const css = stripComments(read(file));
  const out: string[] = [];
  for (const word of ["gradient(", "drop-shadow", "blur(", "text-shadow"]) {
    if (css.includes(word)) out.push(word);
  }
  for (const m of css.matchAll(/box-shadow\s*:\s*([^;}]*)/g)) {
    const v = m[1].trim();
    if (v !== "var(--rf-ring)" && v !== "none") out.push(`box-shadow:${v}`);
  }
  return out;
};

describe("T14b scoped: no retired token in this lane's files", () => {
  it.each(MINE)("%s references no retired name or alias of one", (file) => {
    expect(refs(file, RETIRED)).toEqual([]);
    expect(refs(file, ALIASES)).toEqual([]);
  });

  // An empty table is fine (every file is clean): it.each throws on no rows, so the block is conditional.
  if (T14B_ROWS.length > 0) {
    it.each(T14B_ROWS.map((r) => [r.file, r.lane, r.wave]))(
      "%s still references a retired name (owned by %s, %s): a clean file loses its row",
      (file) => {
        expect(refs(file, RETIRED).length).toBeGreaterThan(0);
      },
    );
  }

  it("no other site CSS file references a retired name without a row", () => {
    const rows = new Set(T14B_ROWS.map((r) => r.file));
    for (const file of allSiteCss()) {
      if (MINE.includes(file) || rows.has(file)) continue;
      expect({ file, refs: refs(file, RETIRED) }).toEqual({ file, refs: [] });
    }
  });

  it("every row names a real css file once, with a lane and a wave", () => {
    const files = T14B_ROWS.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    for (const r of T14B_ROWS) {
      expect(allSiteCss()).toContain(r.file);
      expect(MINE).not.toContain(r.file);
      expect(r.lane).toMatch(/\S/);
      expect(r.wave).toMatch(/^W\d/);
    }
  });
});

describe("T18a scoped: flat, one ring", () => {
  it.each(MINE)("%s has no gradient, blur, glow or shadow other than the ring", (file) => {
    expect(flatOffences(file)).toEqual([]);
  });

  // An empty table is fine (every file is flat): it.each throws on no rows, so the block is conditional.
  if (T18A_ROWS.length > 0) {
    it.each(T18A_ROWS.map((r) => [r.file, r.lane, r.wave]))(
      "%s is still not flat (owned by %s, %s): a flat file loses its row",
      (file) => {
        expect(flatOffences(file).length).toBeGreaterThan(0);
      },
    );
  }

  it("no other site CSS file is un-flat without a row", () => {
    const rows = new Set(T18A_ROWS.map((r) => r.file));
    for (const file of allSiteCss()) {
      if (MINE.includes(file) || rows.has(file)) continue;
      expect({ file, offences: flatOffences(file) }).toEqual({ file, offences: [] });
    }
  });

  it("every row names a real css file once", () => {
    const files = T18A_ROWS.map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    for (const r of T18A_ROWS) {
      expect(allSiteCss()).toContain(r.file);
      expect(MINE).not.toContain(r.file);
    }
  });
});

// Every stylesheet read goes through the shared postcss reader (SA-1203 A20 R1).
const cssRulesOf = (css: string, source = "css") => readCss(css, source).rules;

describe("T15 static: colour only through tokens; every band is white, bone or ink", () => {
  it.each(MINE)("%s types no colour literal in a declaration", (file) => {
    const bad: string[] = [];
    for (const r of cssRulesOf(read(file))) {
      for (const [prop, value] of Object.entries(r.decls)) {
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/i.test(value)) {
          bad.push(`${r.selectors[0]} { ${prop}: ${value} }`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // Band-level selectors in this lane's files (the section backgrounds), by file.
  const BANDS: Record<string, string[]> = {
    "public/site/css/color-deep.css": [
      ".pd .pd-top",
      ".pd .pd-all",
      ".pd .pd-how",
      ".pd .pd-who",
      ".pd .pd-grow",
      ".pd .gs-people",
      ".pd .co-story",
      ".pd .co-ask",
      ".pd .pd-deep",
    ],
    "public/site/css/product.css": [".pd-how", ".pd-who", ".pd-deep"],
    "public/site/css/home-color.css": [
      ".home .jr",
      ".home .st",
      ".home .ct",
      ".home .inc",
      ".home .fq",
    ],
    "components/site-frame/site-frame.css": [".rf-frame", ".rf-frame-main--narrow"],
  };
  const THREE = new Set(["var(--rf-white)", "var(--rf-soft)", "var(--rf-panel)"]);

  it.each(Object.entries(BANDS))("%s: each band background is white, bone or ink", (file, sels) => {
    const rules = cssRulesOf(read(file));
    for (const sel of sels) {
      const hits = rules.filter((r) => r.selectors.includes(sel));
      const painted = hits.filter((r) => r.decls.background || r.decls["background-color"]);
      expect({ sel, painted: painted.length > 0 }).toEqual({ sel, painted: true });
      for (const r of hits) {
        const v = r.decls.background ?? r.decls["background-color"];
        if (v !== undefined) expect({ sel, v, ok: THREE.has(v) }).toEqual({ sel, v, ok: true });
        expect(r.decls["background-image"]).toBeUndefined();
      }
    }
  });

  it("the three tokens are the only band colours the repaint names", () => {
    const text = MINE.map(read).join("\n");
    expect(text).not.toMatch(/--rf-(?:brand|sun|coral|mint)/);
  });
});

describe("review fixes: disc, hero figure, dark-panel pairs", () => {
  const ruleFor = (file: string, sel: string) =>
    cssRulesOf(read(file)).filter((r) => r.selectors.includes(sel));
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const PAL = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../packages/types/brand/palette.json"),
      "utf8",
    ),
  ).color as Record<string, string>;
  // Job token to palette colour (the job table in rf-graphics.css).
  const JOB: Record<string, string> = {
    "var(--rf-text)": PAL.ink,
    "var(--rf-panel)": PAL.ink,
    "var(--rf-on-panel)": PAL.white,
    "var(--rf-on-panel-2)": PAL.bone,
    "var(--rf-soft)": PAL.bone,
    "var(--rf-white)": PAL.white,
  };

  it("the founder monogram disc differs from the panel it sits on and keeps AA letters", () => {
    const r = ruleFor("public/site/css/home-color.css", "#founder .fd-mono");
    expect(r.length).toBe(1);
    const bg = r[0].decls.background;
    const fg = r[0].decls.color;
    expect(bg).not.toBe("var(--rf-panel)");
    expect(JOB[bg]).not.toBe(JOB["var(--rf-panel)"]);
    expect(ratio(JOB[bg], JOB[fg])).toBeGreaterThanOrEqual(4.5);
  });

  it("the hero figure on the two diagram pages stays centred against the text column", () => {
    const r = ruleFor("public/site/css/does.css", ".pd-top .dd-flow");
    expect(r.some((x) => x.decls["align-self"] === "center")).toBe(true);
  });

  it("each dark-panel text rule names its intended pair and that pair is AA", () => {
    const pairs: Array<[string, string, string, string]> = [
      ["public/site/css/product.css", ".pd-deep", "background", "color"],
    ];
    const deep = ruleFor("public/site/css/product.css", ".pd-deep")[0].decls;
    expect(deep.background).toBe("var(--rf-panel)");
    expect(deep.color).toBe("var(--rf-on-panel)");
    expect(ratio(JOB[deep.background], JOB[deep.color])).toBeGreaterThanOrEqual(4.5);
    expect(pairs.length).toBe(1);
    const sub = ruleFor("public/site/css/product.css", ".pd-deep .sub")[0].decls;
    expect(sub.color).toBe("var(--rf-on-panel-2)");
    expect(ratio(JOB["var(--rf-panel)"], JOB[sub.color])).toBeGreaterThanOrEqual(4.5);
    // the label on the dark panel is a bone pill with ink text, so its pair is ink on bone
    const kickBg = ruleFor("public/site/css/color-deep.css", ".pd .kick")[0].decls.background;
    const kickFg = ruleFor("public/site/css/product.css", ".pd-head--deep .kick")[0].decls.color;
    expect(kickBg).toBe("var(--rf-soft)");
    expect(kickFg).toBe("var(--rf-text)");
    expect(ratio(JOB[kickBg], JOB[kickFg])).toBeGreaterThanOrEqual(4.5);
  });

  it("the legal table does not double its last line against the wrapper ring", () => {
    const css = read("components/site-frame/site-frame.css");
    expect(css).toMatch(/tbody tr:last-child\s*td[\s\S]*?border-bottom:\s*0/);
  });
});

// T17 static (a, b): copper stays inside its listed jobs and is never a status colour (R17).
// Sources: every site CSS file, plus every <style> block and inline style="" in public/site/*.html.
// Copper reaches a rule as a palette hex (also as %23 hex, rgb() or hsl()), as any hex, rgb() or hsl() whose
// hue is copper, or as a token that resolves to one (var() followed to a fixed point). Custom-property
// definitions are plumbing: the rules that read them are the uses, and each is keyed
// `source :: selectors :: property`.
// The app's own copper values are the palette's (packages/types/brand/palette.json, the file the app's
// BrandTokens component injects as --brand-copper*); the tests read them, never type them.
const PALETTE = JSON.parse(
  fs.readFileSync(path.join(WEB, "../../packages/types/brand/palette.json"), "utf8"),
).color as Record<string, string>;
const COPPER_HEXES = Object.entries(PALETTE)
  .filter(([k]) => k.startsWith("copper"))
  .map(([, v]) => v.replace("#", "").toLowerCase());

const toRgb = (hex: string): [number, number, number] => {
  // 3 and 4 digits double up (the 4th is alpha); 6 and 8 digits keep the first six (the last two are alpha)
  const h = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
/** Copper by hue (orange-brown, mid saturation, mid lightness): catches a copper typed in a new place. */
const copperLike = ([r, g, b]: [number, number, number]): boolean => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return false;
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = (max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4) * 60;
  const hue = (h + 360) % 360;
  return hue >= 15 && hue <= 35 && s >= 0.35 && s <= 0.72 && l >= 0.25 && l <= 0.75;
};
const PALETTE_COPPER_RGB = COPPER_HEXES.map(toRgb);
/** Colour literals in a value, as rgb triples. */
const literalsOf = (v: string): Array<[number, number, number]> => {
  const out: Array<[number, number, number]> = [];
  for (const m of v.matchAll(
    /(?:#|%23)([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z])/gi,
  ))
    out.push(toRgb(m[1]));
  for (const m of v.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi))
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  for (const m of v.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi))
    out.push(hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100));
  return out;
};
const sameRgb = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 1);
const isAppCopper = (c: [number, number, number]) => PALETTE_COPPER_RGB.some((p) => sameRgb(p, c));

type CopperRule = {
  source: string;
  selectors: string[];
  decls: Record<string, string>;
  at?: string;
  line?: number;
};

const toCopper = (r: CssRule): CopperRule => ({
  source: r.source,
  selectors: r.selectors,
  decls: r.decls,
  at: r.at,
  line: r.line,
});

// Pages are read as served (the page-read pin): the <style> blocks and inline style stay in the served html.
const siteHtml = (): Array<{ name: string; html: string }> =>
  STATIC_SITE_PAGE_NAMES.map((p) => ({
    name: `${p}.html`,
    html: readServedSitePage(p, { websiteId: undefined }),
  }));

// Inline style="" attributes of one page, one rule each, read from a parsed document (never by regex).
const inlineStyleRules = (name: string, html: string): CopperRule[] =>
  [...new JSDOM(html).window.document.querySelectorAll("[style]")].flatMap((el) =>
    readStyleAttr(el.getAttribute("style") ?? "", `${name} style=""`).rules.map(toCopper),
  );

// ---- The served sources, read through one front end (SA-1203 A24, round 4) ----------------------------
// JSDOM with node locations parses each page and each svg file; every css text (a <style> block's text, a
// style="" value, a stylesheet) goes through the shared postcss reader. Nothing is read from raw bytes, and
// anything the parser leaves open is a red with `file:line:col  form=  found=  rule=  Fix:`.
const FIX_RAISE = "stop, raise with the lead; on approval pin file + form + ruling id.";
const mkRed = (
  file: string,
  line: number,
  col: number,
  form: string,
  found: string,
  rule: string,
  fix = FIX_RAISE,
) => `${file}:${line}:${col}  form=${form}  found=${found.slice(0, 80)}  rule=${rule}  Fix: ${fix}`;

/** Reds the owner or lead has approved: file + form + text + ruling + the file's full sha256, each matching
 *  exactly once (the A21 shape). A one-byte change to the file breaks the hash and the red comes back. */
type LegitRed = { file: string; form: string; text: string; ruling: string; sha256: string };
const LEGIT_REDS: LegitRed[] = [
  {
    file: "public/site/img/brand/favicon.svg",
    form: "svg-attr",
    text: "#000000",
    ruling: "SA-1203 A25 R-c",
    sha256: "555edc8e719e0528173fd4c6e77624d569d6d8f538a23aa986ec251662277813",
  },
];
const applyLegitReds = (
  reds: string[],
  hashOf: (file: string) => string | null,
  legit: LegitRed[] = LEGIT_REDS,
): string[] => {
  const left = [...reds];
  const extra: string[] = [];
  for (const l of legit) {
    const hits = left.filter(
      (r) => r.startsWith(l.file + ":") && r.includes("form=" + l.form) && r.includes(l.text),
    );
    if (hashOf(l.file) !== l.sha256) {
      extra.push(
        mkRed(
          l.file,
          0,
          0,
          l.form,
          l.text,
          "legit-red-hash",
          "the file changed: stop, raise with the lead.",
        ),
      );
    } else if (hits.length !== 1)
      extra.push(
        mkRed(l.file, 0, 0, l.form, l.text, "legit-red-not-once", "an allowed red must match once"),
      );
    else left.splice(left.indexOf(hits[0]), 1);
  }
  return [...left, ...extra];
};

type Page = { name: string; html: string };
type TextFile = { path: string; text: string };
type SourceInputs = { pages: Page[]; sheets: TextFile[]; svgs: TextFile[] };
type SourceCensus = {
  stylesheets: number;
  styleBlocks: number;
  paletteBlocks: number;
  styleAttrs: number;
  svgFiles: number;
  templates: number;
  svgStyles: number;
  dataUrls: number;
  escapes: number;
  inlineSvg: number;
  noscript: number;
  inlineScripts: number;
};
type SiteRead = { rules: CopperRule[]; problems: string[]; census: SourceCensus };

// The logo key: the brand folder plus the one reversed mark directly in img/ (named once, here).
const BRAND_SVG_DIR = "public/site/img/brand/";
const NAMED_REVERSED_MARK = "public/site/img/routeflow-mark-reversed.svg";
const SVG_COLOUR_ATTRS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"];
const SVG_ANIMATE_ATTRS = ["from", "to", "by", "values"];
const hexKey = (v: string): string | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? [...h].map((c) => c + c).join("") : h;
};
const PALETTE_HEX_SET = new Set(
  Object.values(PALETTE)
    .map((v) => hexKey(v))
    .filter((v): v is string => v !== null),
);
const NEUTRAL_PAINT = /^(?:none|currentcolor|url\(\s*#[\w-]+\s*\))$/i;
const PALETTE_VAR = /^var\(\s*--(?:rf|brand)-[\w-]+\s*\)$/;
const paintOk = (value: string, inLogoKey: boolean): boolean => {
  const v = value.trim();
  if (NEUTRAL_PAINT.test(v)) return true;
  if (inLogoKey) {
    const h = hexKey(v);
    return h !== null && PALETTE_HEX_SET.has(h);
  }
  return PALETTE_VAR.test(v);
};

/** Colour attributes of one element, and the colour-valued animation attributes. */
const colourAttrsOf = (el: Element): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const a of SVG_COLOUR_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null) out.push([a, v]);
  }
  const tag = el.tagName.toLowerCase();
  if (
    (tag === "animate" || tag === "set") &&
    SVG_COLOUR_ATTRS.includes(el.getAttribute("attributeName") ?? "")
  ) {
    for (const a of SVG_ANIMATE_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) for (const part of a === "values" ? v.split(";") : [v]) out.push([a, part]);
    }
  }
  return out;
};

// whitespace in a value is not a difference (postcss keeps it for custom properties)
const palettePageSignature = (css: string) =>
  JSON.stringify(
    readCss(css, "palette").rules.map((r) => [
      r.at,
      r.selectors,
      Object.fromEntries(
        Object.entries(r.decls).map(([k, v]) => [k, v.replace(/s+/g, " ").trim()]),
      ),
    ]),
  );
let paletteSignatureCache: string | null = null;
const expectedPaletteSignature = () => {
  if (paletteSignatureCache) return paletteSignatureCache;
  const tag = new JSDOM(brandTokensTag(loadPalette())).window.document.querySelector("style");
  return (paletteSignatureCache = palettePageSignature(tag?.textContent ?? ""));
};

const sheetPathOf = (href: string): string => {
  const clean = href.split(/[?#]/)[0];
  return clean.startsWith("/") ? "public" + clean : "public/site/" + clean;
};

/** A CSS `url(...)` with its address, quoted or not. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;
const NONCOPPER_PALETTE_HEX = new Set(
  Object.entries(PALETTE)
    .filter(([k]) => !k.startsWith("copper"))
    .map(([, v]) => hexKey(v))
    .filter((v): v is string => v !== null),
);

/** A CSS data: URL, read as svg source (SA-1203 A25 R-a): decoded, parsed as XML, and every colour in it
 *  scanned. Anything the reader cannot open fails closed as an unread container. */
function readDataUrlSvg(uri: string, source: string, line: number): string[] {
  const red = (found: string, rule: string, fix?: string) =>
    mkRed(source, line, 0, "data-url", found, rule, fix);
  const comma = uri.indexOf(",");
  if (comma < 0) return [red(uri, "unread-container")];
  const parts = uri
    .slice(5, comma)
    .split(";")
    .map((s) => s.trim().toLowerCase());
  if (parts.includes("base64")) return [red(";base64", "unread-container")];
  if (parts[0] !== "image/svg+xml") return [red(parts[0] || "(no media type)", "unread-container")];
  let text: string;
  try {
    text = decodeURIComponent(uri.slice(comma + 1));
  } catch {
    return [red("decode error", "unread-container")];
  }
  let doc: Document;
  try {
    doc = new JSDOM(text, { contentType: "image/svg+xml" }).window.document;
  } catch {
    return [red("xml parse error", "unread-container")];
  }
  const reds: string[] = [];
  if (/var\(/i.test(text)) reds.push(red("var()", "unread-container"));
  if (literalsOf(text).some((c) => copperLike(c) || isAppCopper(c)))
    reds.push(red("a copper colour", "copper-in-data-url"));
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (["style", "image", "use"].includes(tag)) reds.push(red(`<${tag}>`, "unread-container"));
    for (const a of el.getAttributeNames()) {
      const n = a.toLowerCase();
      if (n === "style" || n === "href" || n.endsWith(":href"))
        reds.push(red(`${n} attribute`, "unread-container"));
    }
    for (const [a, v] of colourAttrsOf(el)) {
      const h = hexKey(v);
      if (/^(?:none|currentcolor)$/i.test(v.trim()) || (h !== null && NONCOPPER_PALETTE_HEX.has(h)))
        continue;
      const rgb = literalsOf(v);
      const copper = rgb.some((c) => copperLike(c) || isAppCopper(c));
      reds.push(red(`${a}="${v}"`, copper ? "copper-in-data-url" : "data-url-off-palette"));
    }
  }
  return [...new Set(reds)];
}

/** Read every served source. */
function readSources(inp: SourceInputs): SiteRead {
  const rules: CopperRule[] = [];
  const problems: string[] = [];
  const census: SourceCensus = {
    stylesheets: 0,
    styleBlocks: 0,
    paletteBlocks: 0,
    styleAttrs: 0,
    svgFiles: 0,
    templates: 0,
    svgStyles: 0,
    dataUrls: 0,
    escapes: 0,
    inlineSvg: 0,
    noscript: 0,
    inlineScripts: 0,
  };
  // a data URL is counted once per rule (a prefixed and an unprefixed declaration share one)
  const seenData = new Set<string>();
  const takeCss = (r: ReturnType<typeof readCss>) => {
    rules.push(...r.rules.map(toCopper));
    problems.push(...r.problems);
    census.escapes += r.problems.filter((p) => p.includes("rule=escape-outside-string")).length;
    for (const d of r.decls)
      for (const m of d.value.matchAll(CSS_URL)) {
        const uri = (m[1] ?? m[2] ?? m[3] ?? "").trim();
        if (!/^data:/i.test(uri)) continue;
        const key = `${d.source}:${d.line}:${uri}`;
        if (seenData.has(key)) continue;
        seenData.add(key);
        census.dataUrls++;
        problems.push(...readDataUrlSvg(uri, d.source, d.line));
      }
  };
  const sheetSet = new Set(allSiteCss());

  for (const sh of inp.sheets) {
    census.stylesheets++;
    takeCss(readCss(sh.text, sh.path.replace("public/site/", "")));
  }

  // one parsed document (page or svg file): the checks they share, applied to the document and, with the
  // same rules, to the content of every <template> in it (SA-1203 A25 R-b)
  const checkDoc = (dom: JSDOM, file: string, label: string, isSvgFile: boolean) => {
    const doc = dom.window.document;
    const loc = (el: Element) => {
      const l = dom.nodeLocation(el) as { startLine?: number; startCol?: number } | null;
      return [l?.startLine ?? 0, l?.startCol ?? 0] as const;
    };
    const red = (el: Element, form: string, found: string, rule: string, fix?: string) => {
      const [line, col] = loc(el);
      problems.push(mkRed(file, line, col, form, found, rule, fix));
    };
    let palette = 0;
    const scan = (root: ParentNode) => {
      for (const el of root.querySelectorAll("style")) {
        if (isSvgFile || el.closest("svg")) {
          census.svgStyles++;
          red(el, "svg-style", "<style> in svg", "unread-container");
          continue;
        }
        if (el.getAttribute("id") === "brand-tokens") {
          palette++;
          census.paletteBlocks++;
          if (palettePageSignature(el.textContent ?? "") !== expectedPaletteSignature())
            red(
              el,
              "palette-block",
              (el.textContent ?? "").slice(0, 40),
              "palette-content-mismatch",
            );
          continue;
        }
        census.styleBlocks++;
        const l = dom.nodeLocation(el) as { startTag?: { endLine?: number } } | null;
        takeCss(readCss(el.textContent ?? "", `${label} <style>`, (l?.startTag?.endLine ?? 1) - 1));
      }
      for (const el of root.querySelectorAll("[style]")) {
        census.styleAttrs++;
        const l = dom.nodeLocation(el) as { attrs?: Record<string, { startLine: number }> } | null;
        takeCss(
          readStyleAttr(
            el.getAttribute("style") ?? "",
            `${label} style=""`,
            (l?.attrs?.style?.startLine ?? 1) - 1,
          ),
        );
      }
      for (const el of root.querySelectorAll("template")) {
        census.templates++;
        const content = (el as HTMLTemplateElement).content;
        if (!content || content.nodeType !== 11)
          red(el, "template", "<template> without content", "unread-container");
        else scan(content);
      }
      for (const el of root.querySelectorAll("iframe[srcdoc], object, embed"))
        red(el, el.tagName.toLowerCase(), `<${el.tagName.toLowerCase()}>`, "unread-container");
      for (const el of root.querySelectorAll("noscript")) {
        census.noscript++;
        if (
          el.querySelector("style, [style], link") ||
          /<(?:style|link)\b|\sstyle\s*=/i.test(el.textContent ?? "")
        )
          red(el, "noscript", "<noscript> with style or link", "unread-container");
      }
      for (const el of root.querySelectorAll("link")) {
        const href = el.getAttribute("href") ?? "";
        if (/^\s*data:/i.test(href)) {
          census.dataUrls++;
          red(el, "data-url", href, "unread-container");
        } else if (
          (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")
        ) {
          if (!sheetSet.has(sheetPathOf(href)))
            red(el, "link-stylesheet", href, "unread-container");
        }
      }
      for (const el of root.querySelectorAll("*"))
        for (const a of ["href", "xlink:href"]) {
          const v = el.getAttribute(a);
          if (
            v !== null &&
            /^\s*data:/i.test(v) &&
            el.tagName.toLowerCase() !== "link" &&
            (el.closest("svg") || isSvgFile)
          ) {
            census.dataUrls++;
            red(el, "data-url", v, "unread-container");
          }
        }
      if (isSvgFile) return;
      census.inlineScripts += [...root.querySelectorAll("script")].filter(
        (s) => !s.hasAttribute("src"),
      ).length;
      for (const svg of root.querySelectorAll("svg")) {
        census.inlineSvg++;
        for (const el of [svg, ...svg.querySelectorAll("*")])
          for (const [a, v] of colourAttrsOf(el))
            if (!paintOk(v, false)) {
              const [line, col] = loc(el);
              problems.push(
                mkRed(
                  file,
                  line,
                  col,
                  "svg-attr",
                  `${a}="${v}"`,
                  "svg-colour-attr",
                  "stop, raise with the lead; the inline svg takes only none, currentColor, url(#id) or var(--palette token).",
                ),
              );
            }
      }
    };
    scan(doc);
    if (!isSvgFile && palette !== 1)
      problems.push(
        mkRed(
          file,
          0,
          0,
          "palette-block",
          `${palette} blocks`,
          "palette-content-mismatch",
          "each page has exactly one palette block",
        ),
      );
    return doc;
  };

  for (const page of inp.pages) {
    checkDoc(new JSDOM(page.html, { includeNodeLocations: true }), page.name, page.name, false);
  }

  for (const svgFile of inp.svgs) {
    census.svgFiles++;
    try {
      new JSDOM(svgFile.text, { contentType: "image/svg+xml" });
    } catch (e) {
      problems.push(mkRed(svgFile.path, 0, 0, "svg-xml", String(e), "svg-not-well-formed"));
    }
    const dom = new JSDOM(svgFile.text, { includeNodeLocations: true });
    const doc = checkDoc(dom, svgFile.path, svgFile.path, true);
    const inLogoKey =
      svgFile.path.startsWith(BRAND_SVG_DIR) || svgFile.path === NAMED_REVERSED_MARK;
    for (const el of doc.querySelectorAll("*"))
      for (const [a, v] of colourAttrsOf(el))
        if (!paintOk(v, inLogoKey)) {
          const l = dom.nodeLocation(el) as { startLine?: number; startCol?: number } | null;
          problems.push(
            mkRed(
              svgFile.path,
              l?.startLine ?? 0,
              l?.startCol ?? 0,
              "svg-attr",
              `${a}="${v}"`,
              inLogoKey ? "logo-off-palette" : "svg-colour-attr",
              inLogoKey
                ? "stop, raise with the lead; a logo file may carry palette hexes only."
                : "stop, raise with the lead; an svg takes only none, currentColor, url(#id) or var(--palette token).",
            ),
          );
        }
  }
  return { rules, problems, census };
}

const siteSvgFiles = (): TextFile[] => {
  const out: TextFile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
      const rel = dir + "/" + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".svg")) out.push({ path: rel, text: read(rel) });
    }
  };
  walk("public/site");
  return out.sort((a, b) => a.path.localeCompare(b.path));
};
const realInputs = (): SourceInputs => ({
  pages: siteHtml(),
  sheets: allSiteCss().map((f) => ({ path: f, text: read(f) })),
  svgs: siteSvgFiles(),
});

let siteReadCache: SiteRead | null = null;
const siteRead = (): SiteRead => (siteReadCache ??= readSources(realInputs()));
const copperSources = (): CopperRule[] => siteRead().rules;

const COPPER_SEEDS = ["--brand-copper", "--brand-copper-light", "--brand-copper-dark"];

/** Every copper use as `source :: selectors :: property` (a rule inside @media or @supports gains the chain:
 *  `source :: @media... :: selectors :: property`), every rule kept: the same full key with the same value
 *  is one use, with a different value it is listed in `dupes`. Function names match in any case, custom
 *  property names do not. With the tokens that are copper and the ones
 *  that are not the app's own copper. */
function copperScan(extra: CopperRule[] = []) {
  const rules = [...copperSources(), ...extra];
  const tokens = new Set(COPPER_SEEDS);
  const nonApp = new Set<string>();
  const lits = (v: string) => literalsOf(v).filter((c) => copperLike(c) || isAppCopper(c));
  const refs = (v: string) => [...v.matchAll(/var\(\s*(--[\w-]+)/gi)].map((m) => m[1]);
  const hasCopper = (v: string) => lits(v).length > 0 || refs(v).some((t) => tokens.has(t));
  const hasNonApp = (v: string) =>
    lits(v).some((c) => !isAppCopper(c)) || refs(v).some((t) => nonApp.has(t));
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rules)
      for (const [p, v] of Object.entries(r.decls)) {
        if (!p.startsWith("--") || COPPER_SEEDS.includes(p)) continue;
        if (hasCopper(v) && !tokens.has(p)) (tokens.add(p), (grew = true));
        if (hasNonApp(v) && !nonApp.has(p)) (nonApp.add(p), (grew = true));
      }
  }
  const uses: Array<{ key: string; rule: CopperRule; prop: string; nonApp: boolean }> = [];
  const seen = new Map<string, Set<string>>();
  for (const r of rules)
    for (const [p, v] of Object.entries(r.decls)) {
      if (!hasCopper(v)) continue;
      const key = [r.source, r.at, r.selectors.join(", "), p].filter((x) => x).join(" :: ");
      const values = seen.get(key) ?? new Set<string>();
      if (values.has(v)) continue;
      values.add(v);
      seen.set(key, values);
      uses.push({ key, rule: r, prop: p, nonApp: hasNonApp(v) });
    }
  const dupes = [...seen]
    .filter(([, v]) => v.size > 1)
    .map(([k]) => `${k} (duplicate key, different value)`);
  uses.sort((a, b) => a.key.localeCompare(b.key));
  return { uses, rules, dupes };
}
const copperUses = (): string[] => copperScan().uses.map((u) => u.key);

// A status rule is one whose selector names a status, or whose declarations also use a status token.
const STATUS_WORDS =
  /(?:^|[^a-z])(?:status|success|ok|paid|pending|overdue|late|warn(?:ing)?|error|danger|fail(?:ed|ure)?|alert|invalid|valid|bad)(?![a-z])/i;
const STATUS_TOKEN = /[vV][aA][rR]\(\s*--(?:rf|brand)-(?:paid|pending|overdue)/;
// The :root block defines every token, status and copper alike, so "it also uses a status token" cannot
// apply to it; its tokens are judged by property name (STATUS_WORDS on the property) and by value.
const isStatusRule = (r: { selectors: string[]; decls: Record<string, string> }) =>
  r.selectors.some((s) => STATUS_WORDS.test(s)) ||
  (!r.selectors.every((s) => s === ":root") &&
    Object.values(r.decls).some((v) => STATUS_TOKEN.test(v)));

// R17's jobs (run spec.md:84), and the one the owner added for pictures of the app (SA-1203 A4, 2026-11-21).
const R17_JOBS = [
  "logo symbol and dot",
  "the wheel part in focus",
  "the step in view",
  "pricing bars",
  "eyebrow dot",
  "one problem-section note",
  "text links",
] as const;
const PICTURE = "picture of the app (owner, 2026-11-21, SA-1203 A4)";

// A definition of one of the five copper tokens, in a pinned scope (SA-1203 A6 2). An alias is a use, not this.
const TOKEN_DEF = "token definition";
// Picture-of-the-app rows the owner has not yet ruled on (SA-1203 A6 1); not an allowed tag.
const PENDING_OWNER = "PENDING-OWNER R17";
// R17's eighth job: copper accents inside pictures of the app, knowingly apart from the app (SA-1203 A9, A15).
const PICTURE_BRAND = "picture of the app in brand colours (owner, 2026-11-21, SA-1203 A9)";
const PICTURE_BRAND_PREFIX = "picture of the app in brand colours";
// A custom property that aliases a copper token; it paints nothing, so it is judged by its readers (SA-1203 A16).
const COPPER_ALIAS = "copper alias, every reader tagged (SA-1203 A16)";
const COPPER_ALIAS_COUNT = 5;

const [LOGO, WHEEL, STEP, BARS, DOT, NOTE, LINK] = R17_JOBS;
// The source cell of a row for a rule inside an @media block is the scanner's own prefix: file :: chain.
const HOME_MQ = "css/home.css :: @media (max-width:899.98px)";
const COPPER_ALLOW: Array<[source: string, selectors: string, property: string, tag: string]> = [
  ["components/site-frame/site-frame.css", ".rf-legal a", "color", LINK],
  ["css/color-deep.css", ".pd .kick::before", "background", DOT],
  ["css/company.css", ".co-body a", "color", LINK],
  [
    "css/home-color.css",
    ".home .hx .kick::before, .home #sell .kick::before, .home #journey .kick::before, .home #stores .kick::before, .home #counter .kick::before, .home #use-cases .kick::before",
    "background",
    DOT,
  ],
  ["css/home-up.css", ".featured .pm-bar i", "background", BARS],
  ["css/home-up.css", ".pm-bar i", "background", BARS],
  ["css/home.css", ".a-av", "color", PICTURE_BRAND],
  ["css/home.css", ".a-link2", "color", PICTURE_BRAND],
  ["css/home.css", ".a-nav li.on", "border-left", PICTURE_BRAND],
  ["css/home.css", ".a-nav li.on .ico", "color", PICTURE_BRAND],
  [HOME_MQ, ".ans-i--p .ans-bar", "background", PICTURE_BRAND],
  ["css/home.css", ".b-nav li.on", "border-left", PICTURE_BRAND],
  ["css/home.css", ".b-nav li.on .ico", "color", PICTURE_BRAND],
  ["css/home.css", ".end-mail a", "color", LINK],
  [HOME_MQ, ".fd-more", "color", LINK],
  ["css/home.css", ".fd-note a", "color", LINK],
  ["css/home.css", ".home", "--c-pay", COPPER_ALIAS],
  ["css/home.css", ".home .fq a", "color", LINK],
  [HOME_MQ, ".home #pricing .pl-inc a", "color", LINK],
  ["css/home.css", ".hx-more", "color", LINK],
  ["css/home.css", ".n3", "background", NOTE],
  ["css/home.css", ".rt-d--now", "fill", STEP],
  [HOME_MQ, ".sp-all", "color", LINK],
  ["css/home.css", ".sp-q em", "color", PICTURE_BRAND],
  ["css/home.css", ".sp-q i", "color", PICTURE_BRAND],
  ["css/home.css", ".sp-top span", "color", PICTURE_BRAND],
  ["css/product.css", ".pd main a:not(.btn):not(.pd-tile):not(.link):not(.pd-go)", "color", LINK],
  ["css/product.css", ".pd-go", "color", LINK],
  ["css/product.css", ".pd-more summary", "color", LINK],
  ["css/site.css", ".band-ink a:not(.btn)", "color", LINK],
  ["css/site.css", ".cap::before", "background", DOT],
  ["css/site.css", ".footer-grid a:hover", "color", LINK],
  ["css/site.css", ".link", "color", LINK],
  ["css/site.css", ".pg-top .eyebrow::before", "background", DOT],
  ["css/start.css", ".gs-step a:not(.link)", "color", LINK],
  ["graphics/rf-graphics.css", ":root", "--app-deep", COPPER_ALIAS],
  ["graphics/rf-graphics.css", ":root", "--app-on", COPPER_ALIAS],
  ["graphics/rf-graphics.css", ":root", "--buy-deep", COPPER_ALIAS],
  ["graphics/rf-graphics.css", ":root", "--buy-on", COPPER_ALIAS],
  ["graphics/rf-graphics.css", ":root", "--rf-accent", TOKEN_DEF],
  ["graphics/rf-graphics.css", ":root", "--rf-accent-on-panel", TOKEN_DEF],
  ["graphics/rf-graphics.css", ":root", "--rf-copper", TOKEN_DEF],
  ["graphics/rf-graphics.css", ":root", "--rf-copper-dark", TOKEN_DEF],
  ["graphics/rf-graphics.css", ":root", "--rf-copper-light", TOKEN_DEF],
  ["graphics/rf-graphics.css", ":root", "--rf-link", LINK],
  ["graphics/rf-graphics.css", ":root", "--rf-link-on-panel", LINK],
  ["graphics/rf-graphics.css", ":root", "--rf-wh-focus", WHEEL],
  ["graphics/rf-graphics.css", ":root", "--rf-wh-focus-wall", WHEEL],
  ["graphics/rf-wheel-up.css", ".rfw-t .rfw-eye::before", "background", DOT],
  ["graphics/rf-wheel-up.css", ".rfw-w.f", "fill", WHEEL],
  ["graphics/rf-wheel-up.css", ".rfw-w.f", "stroke", WHEEL],
  ["landing.html <style>", ":root", "--rf-accent", TOKEN_DEF],
  ["landing.html <style>", ":root", "--rf-accent-on-panel", TOKEN_DEF],
  ["landing.html <style>", ":root", "--rf-copper", TOKEN_DEF],
  ["landing.html <style>", ":root", "--rf-copper-dark", TOKEN_DEF],
  ["landing.html <style>", ":root", "--rf-copper-light", TOKEN_DEF],
  ["landing.html <style>", ":root", "--rf-link", LINK],
  ["landing.html <style>", ":root", "--rf-link-on-panel", LINK],
  ["landing.html <style>", ":root", "--rf-wh-focus", WHEEL],
  ["landing.html <style>", ":root", "--rf-wh-focus-wall", WHEEL],
  ["landing.html <style>", ".foot a", "color", LINK],
];
const ruleKey = (r: CopperRule, property: string) =>
  [r.source, r.at, r.selectors.join(", "), property].filter((x) => x).join(" :: ");
const copperKey = (source: string, selectors: string, property: string) =>
  `${source} :: ${selectors} :: ${property}`;

const stripState = (sel: string) =>
  sel.replace(/::?(?:before|after|hover|focus-visible|focus|active)\b/g, "");

// A picture row's tag is PICTURE plus " @ <repo path>:<line>", the line in the app that shows the same
// copper (SA-1203 A5). The cited line must exist and must name a copper (the word, or a palette hex).
const repoRoot = path.join(WEB, "../..");
function citeOk(tag: string): boolean {
  if (!tag.startsWith(`${PICTURE} @ `)) return false;
  const m = /@ (\S+):(\d+)$/.exec(tag);
  if (!m) return false;
  const file = path.join(repoRoot, m[1]);
  if (!fs.existsSync(file)) return false;
  const line = fs.readFileSync(file, "utf8").split("\n")[Number(m[2]) - 1] ?? "";
  return /copper/i.test(line) || COPPER_HEXES.some((h) => line.toLowerCase().includes(h));
}
const isAllowedTag = (tag: string) =>
  (R17_JOBS as readonly string[]).includes(tag) ||
  tag === TOKEN_DEF ||
  tag === PICTURE_BRAND ||
  tag === COPPER_ALIAS;

type UseInfo = { nonApp: boolean };
/** Why each picture row fails, if it does: no app cite, not the app's copper, not a css rule, or not
 *  inside a labelled illustration figure (the one rule T10 uses). */
function pictureOffences(
  rows: Array<[string, string, string, string]>,
  uses: Map<string, UseInfo>,
  docs: Document[],
): string[] {
  const offenders: string[] = [];
  for (const [source, selectors, property, tag] of rows) {
    if (!tag.startsWith(PICTURE)) continue;
    const key = copperKey(source, selectors, property);
    if (!citeOk(tag)) offenders.push(`${key} (no app file:line that shows the copper)`);
    const use = uses.get(key);
    if (!use || use.nonApp) offenders.push(`${key} (not the app's copper)`);
    if (!source.endsWith(".css")) offenders.push(`${key} (only a css rule can be a picture row)`);
    let matched = 0;
    for (const sel of selectors.split(", ")) {
      for (const d of docs) {
        let els: Element[] = [];
        try {
          els = [...d.querySelectorAll(stripState(sel))];
        } catch {
          offenders.push(`${key} (selector not readable)`);
        }
        for (const el of els) {
          matched++;
          if (!closestIllustration(el)) offenders.push(`${key} (outside a figure: ${sel})`);
        }
      }
    }
    if (matched === 0) offenders.push(`${key} (matches nothing)`);
  }
  return [...new Set(offenders)];
}

type BrandUse = { value: string; status: boolean };
/** Why each brand-colour picture row fails, if it does (SA-1203 A9): outside a labelled figure, a typed
 *  colour or a token that is not a palette copper token, a status rule, or an app file cite. Every rule
 *  that shares the row's key is checked, in every @media / @supports block, not only the first. */
function brandPictureOffences(
  rows: Array<[string, string, string, string]>,
  uses: Map<string, BrandUse[]>,
  docs: Document[],
  aliases: ReadonlySet<string> = new Set(),
): string[] {
  const offenders: string[] = [];
  for (const [source, selectors, property, tag] of rows) {
    if (!tag.startsWith(PICTURE_BRAND_PREFIX)) continue;
    const key = copperKey(source, selectors, property);
    if (property.startsWith("--"))
      offenders.push(`${key} (a definition: A9 is for uses in figures)`);
    if (tag !== PICTURE_BRAND) offenders.push(`${key} (no app file cite is allowed on this tag)`);
    const all = uses.get(key) ?? [];
    if (all.length === 0) offenders.push(`${key} (not a copper use)`);
    for (const use of all) {
      if (use.status) offenders.push(`${key} (a status rule)`);
      const refs = [...use.value.matchAll(/var\(\s*(--[\w-]+)/gi)].map((m) => m[1]);
      if (literalsOf(use.value).length > 0) offenders.push(`${key} (a typed colour)`);
      if (!refs.some((t) => /^--rf-(copper|accent)/.test(t) || aliases.has(t)))
        offenders.push(`${key} (not var(--rf-copper...) or var(--rf-accent...))`);
    }
    if (!source.split(" :: ")[0].endsWith(".css"))
      offenders.push(`${key} (only a css rule can be a picture row)`);
    let matched = 0;
    for (const sel of selectors.split(", ")) {
      for (const d of docs) {
        let els: Element[] = [];
        try {
          els = [...d.querySelectorAll(stripState(sel))];
        } catch {
          offenders.push(`${key} (selector not readable)`);
        }
        for (const el of els) {
          matched++;
          if (!closestIllustration(el)) offenders.push(`${key} (outside a figure: ${sel})`);
        }
      }
    }
    if (matched === 0) offenders.push(`${key} (matches nothing)`);
  }
  return [...new Set(offenders)];
}
/** The A16 alias names (custom property names are case-sensitive; readers are searched in any case). */
const aliasNames = (rows: Array<[string, string, string, string]>) =>
  new Set(rows.filter((r) => r[3] === COPPER_ALIAS).map((r) => r[2]));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The copper-alias guard (SA-1203 A16): each A16 row is exactly var(--rf-copper...), var(--rf-accent...) or
 *  another A16 alias in EVERY rule that defines it, has at least one reader, and every reader is a tagged
 *  row. A reader is found by name, case-insensitively, in every rule of every stylesheet, <style> and
 *  style="" of the site pages (value or property), and in their other text and scripts. */
function aliasOffences(
  rows: Array<[string, string, string, string]>,
  rules: CopperRule[],
  texts: Array<{ name: string; text: string }>,
): string[] {
  const out: string[] = [];
  const names = aliasNames(rows);
  const tagOf = new Map(rows.map(([s, sel, p, t]) => [copperKey(s, sel, p), t]));
  for (const [source, selectors, property, tag] of rows) {
    if (tag !== COPPER_ALIAS) continue;
    const key = copperKey(source, selectors, property);
    const defs = rules.filter(
      (r) => r.source === source && r.selectors.join(", ") === selectors && property in r.decls,
    );
    if (defs.length === 0) out.push(`${key} (no definition found)`);
    for (const def of defs) {
      const m = /^var\(\s*(--[\w-]+)\s*\)$/i.exec(def.decls[property].trim());
      if (!m || !(/^--rf-(copper|accent)/.test(m[1]) || names.has(m[1])))
        out.push(`${key} (value is not a copper token or an alias row)`);
    }
    // R6: in css a read is var(--name (any case of the function, the name exact; nested fallbacks count, a bare
    // name in fallback text does not); in html and js it is the full name as a token
    const inCss = new RegExp("[vV][aA][rR]\\(\\s*" + escapeRe(property) + "(?![\\w-])");
    const asToken = new RegExp("(?<![\\w-])" + escapeRe(property) + "(?![\\w-])");
    let readers = 0;
    for (const r of rules)
      for (const [p, v] of Object.entries(r.decls)) {
        const rk = ruleKey(r, p);
        const isDef = p === property;
        if (!isDef && !inCss.test(v)) continue;
        if (isDef) {
          // another definition of the same name must itself be this tagged row
          if (tagOf.get(rk) !== COPPER_ALIAS) out.push(`${key} (untagged definition: ${rk})`);
          continue;
        }
        readers++;
        const t = tagOf.get(rk);
        const ok =
          t === PICTURE_BRAND ||
          (R17_JOBS as readonly string[]).includes(t ?? "") ||
          (t === COPPER_ALIAS && names.has(p));
        if (!ok) out.push(`${key} (untagged reader: ${rk})`);
      }
    for (const t of texts)
      if (asToken.test(t.text)) {
        readers++;
        out.push(`${key} (untagged reader in ${t.name})`);
      }
    if (readers === 0) out.push(`${key} (a dead alias: no reader)`);
  }
  if (rows.filter((r) => r[3] === COPPER_ALIAS).length !== COPPER_ALIAS_COUNT)
    out.push(`copper alias rows are not ${COPPER_ALIAS_COUNT}`);
  return [...new Set(out)];
}
/** A custom-property name built by concatenation or a template (SA-1203 A20 R7). */
const dynamicPropertyNames = (text: string): string[] =>
  [
    ...text.matchAll(/["']--["']\s*\+/g),
    ...text.matchAll(/\+\s*["']--/g),
    ...text.matchAll(/`[^`]*--\$\{/g),
  ].map((m) => m[0]);

// R7's one vendor exclusion (SA-1203 A21): a third-party file the site does not edit, named by path and full
// sha256, and holding exactly one name-building setProperty, whose value is an index number. Never a folder.
const SPLITTEXT_PATH = "public/site/js/vendor/SplitText.min.js";
const SPLITTEXT_SHA256 = "419f7027a5f086a12cb7988736d8fdd3a6ed2200229661de25b6628ca7ced344";
const R7_EXCLUDED: Array<{ path: string; sha256: string }> = [
  { path: SPLITTEXT_PATH, sha256: SPLITTEXT_SHA256 },
];
const sha256Of = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const NAME_SETPROPERTY = /setProperty\(\s*["']--["']\s*\+/g;
type JsFile = { name: string; bytes: Buffer };
const r7Reds = (files: JsFile[], excluded = R7_EXCLUDED): string[] => {
  const reds: string[] = [];
  for (const f of files) {
    const text = f.bytes.toString("utf8");
    const ex = excluded.find((e) => e.path === f.name);
    if (ex) {
      const matches = (text.match(NAME_SETPROPERTY) ?? []).length;
      if (sha256Of(f.bytes) !== ex.sha256 || matches !== 1)
        reds.push(
          mkRed(
            f.name,
            0,
            0,
            "vendor-pin",
            `sha256 ${sha256Of(f.bytes).slice(0, 16)}, ${matches} matches`,
            "r7-vendor-pin",
          ),
        );
      continue;
    }
    for (const h of dynamicPropertyNames(text))
      reds.push(mkRed(f.name, 0, 0, "js-name", h, "r7-runtime-name"));
  }
  return reds;
};
const siteJsFiles = (): JsFile[] => {
  const out: JsFile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
      const rel = dir + "/" + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".js"))
        out.push({ name: rel, bytes: fs.readFileSync(path.join(WEB, rel)) });
    }
  };
  walk("public/site");
  return out;
};

// The pinned source census (A20 R4, A24 item 7): a new source is a reviewed diff, never a re-pin.
const CENSUS_NOW: SourceCensus = {
  stylesheets: 13,
  styleBlocks: 1,
  paletteBlocks: 10,
  styleAttrs: 24,
  svgFiles: 8,
  templates: 1,
  svgStyles: 0,
  dataUrls: 7,
  escapes: 0,
  inlineSvg: 268,
  noscript: 0,
  inlineScripts: 11,
};
const censusReds = (census: SourceCensus): string[] =>
  (Object.keys(CENSUS_NOW) as Array<keyof SourceCensus>)
    .filter((k) => census[k] !== CENSUS_NOW[k])
    .map((k) =>
      k === "inlineScripts"
        ? mkRed(
            "site",
            0,
            0,
            "script",
            `${census[k]} inline scripts, pinned ${CENSUS_NOW[k]}`,
            "inline-script-count",
            "stop, raise with the lead; M4 is not yet read.",
          )
        : mkRed("site", 0, 0, "census", `${k}=${census[k]}, pinned ${CENSUS_NOW[k]}`, "census-pin"),
    );

/** Site scripts and the page text outside <style> and style="": a reader found here is never tagged. */
const aliasTexts = (): Array<{ name: string; text: string }> => {
  const out = siteJsFiles().map((f) => ({ name: f.name, text: f.bytes.toString("utf8") }));
  for (const { name, html } of siteHtml()) {
    const doc = new JSDOM(html).window.document;
    for (const el of doc.querySelectorAll("style")) el.remove();
    for (const el of doc.querySelectorAll("[style]")) el.removeAttribute("style");
    out.push({ name, text: doc.documentElement.outerHTML });
  }
  return out;
};

/** Everything the guards check at once, for the real tree or for a planted copy. */
const auditSources = (inp: SourceInputs): string[] => {
  const read1 = readSources(inp);
  const allowed = new Set(COPPER_ALLOW.map(([s, sel, p]) => copperKey(s, sel, p)));
  const scan = copperScan(read1.rules);
  const copper = scan.uses
    .filter((u) => !allowed.has(u.key))
    .map((u) =>
      mkRed(
        u.key,
        u.rule.line ?? 0,
        0,
        "copper-use",
        u.rule.decls[u.prop],
        "copper-not-allowed",
        "give it a row under an R17 job, or remove it.",
      ),
    );
  const hashOf = (f: string) => {
    const svg = inp.svgs.find((x) => x.path === f);
    return svg ? sha256Of(Buffer.from(svg.text)) : null;
  };
  return applyLegitReds(
    [...read1.problems, ...censusReds(read1.census), ...copper, ...scan.dupes],
    hashOf,
  );
};
/** The guards' view of copperScan: every copper use, grouped by the row key (no at-rule chain), so a rule
 *  in an @media block or a later rule with the same key is checked as well as the first. */
const brandUses = (extra: CopperRule[] = []) => {
  const out = new Map<string, BrandUse[]>();
  for (const u of copperScan(extra).uses) {
    const use = {
      value: u.rule.decls[u.prop],
      status: isStatusRule(u.rule) || STATUS_WORDS.test(u.prop),
    };
    // under the full key (with its @media chain) and under the chain-less key, so a row keyed without a
    // chain also checks the same rule inside an @media block
    const bare = copperKey(u.rule.source, u.rule.selectors.join(", "), u.prop);
    for (const key of new Set([u.key, bare])) out.set(key, [...(out.get(key) ?? []), use]);
  }
  return out;
};

describe("T17 static: copper only in listed jobs, never a status", () => {
  it("(a) every copper use is on the allow-list, and every allow-list row is still a copper use", () => {
    const allowed = COPPER_ALLOW.map(([s, sel, p]) => copperKey(s, sel, p));
    expect(new Set(allowed).size).toBe(allowed.length);
    const uses = copperUses();
    expect(uses.filter((u) => !allowed.includes(u))).toEqual([]);
    expect(allowed.filter((a) => !uses.includes(a))).toEqual([]);
  });

  // SA-1203 A6 2: the five copper tokens may be defined only in these scopes; an alias is a use with its own tag.
  const DEF_TOKENS = [
    "--rf-copper",
    "--rf-copper-light",
    "--rf-copper-dark",
    "--rf-accent",
    "--rf-accent-on-panel",
  ];
  const DEF_SCOPES = [
    "graphics/rf-graphics.css :: :root",
    "landing.html <style> :: :root",
    "css/home.css :: .pb",
    "css/home.css :: .end",
  ];
  it("(a) the five copper tokens are defined only in the pinned scopes, ten times in all", () => {
    const defs = copperSources().flatMap((r) =>
      Object.keys(r.decls)
        .filter((k) => DEF_TOKENS.includes(k))
        .map((k) => `${r.source} :: ${r.selectors.join(", ")} :: ${k}`),
    );
    expect(defs.filter((d) => !DEF_SCOPES.some((sc) => d.startsWith(sc + " ::")))).toEqual([]);
    expect(defs).toHaveLength(10);
    const tagged = COPPER_ALLOW.filter(([, , , tag]) => tag === TOKEN_DEF);
    expect(tagged).toHaveLength(10);
    for (const [src, sel, prop] of tagged) {
      expect(DEF_TOKENS).toContain(prop);
      expect(DEF_SCOPES).toContain(`${src} :: ${sel}`);
    }
  });

  // SA-1203 A6 4c: a planted fixture, no figure and no page: an inline copper fill is found and is not allowed.
  it("(a) a planted inline copper fill in an svg with no figure is a copper use that is not allowed", () => {
    const html =
      '<svg viewBox="0 0 4 4"><rect width="4" height="4" style="fill:var(--rf-copper)"/></svg>';
    const planted = copperScan(inlineStyleRules("fixture.html", html)).uses.map((u) => u.key);
    const allowed = COPPER_ALLOW.map(([s, sel, p]) => copperKey(s, sel, p));
    expect(planted.filter((k) => !allowed.includes(k))).toEqual([
      'fixture.html style="" :: style :: fill',
    ]);
  });

  // the truck art reads the kraft token (SA-1203 A5 7); its own case, apart from the scan proof above
  it("(a) the truck art fills read the kraft box tokens", () => {
    const fills = copperSources()
      .filter((r) => r.source === 'home.html style=""')
      .flatMap((r) => Object.values(r.decls));
    expect(fills.some((v) => v.includes("--rf-box-front"))).toBe(true);
  });

  it("(a) the scan reads <style> blocks, inline style, custom properties, and every colour form", () => {
    const keys = copperUses();
    expect(keys.some((k) => k.startsWith("landing.html <style> ::"))).toBe(true);
    expect(keys.some((k) => k.endsWith(":: --rf-link"))).toBe(true);
    const [r, g, b] = toRgb(COPPER_HEXES[0]);
    expect(literalsOf(`color: rgb(${r}, ${g}, ${b})`).some(isAppCopper)).toBe(true);
    expect(literalsOf("fill: hsl(23 52% 47%)").some(copperLike)).toBe(true);
    expect(literalsOf("color:#c0733f").some((c) => copperLike(c) && !isAppCopper(c))).toBe(true);
    expect(literalsOf("color:#0e1726").some(copperLike)).toBe(false);
    // 8- and 4-digit hex carry alpha; the colour is the same
    expect(literalsOf(`color:#${COPPER_HEXES[0]}80`).some(isAppCopper)).toBe(true);
    expect(literalsOf("background:url(x%23" + COPPER_HEXES[0] + "80)").some(isAppCopper)).toBe(
      true,
    );
    const short = literalsOf("color:#c738");
    expect(short).toHaveLength(1);
  });

  it("(a) the picture guard accepts a cited, app-copper rule inside a labelled figure", () => {
    const docs = [
      new JSDOM('<figure role="img" aria-label="An app screen."><p class="in">x</p></figure>')
        .window.document,
    ];
    const cite = `${PICTURE} @ apps/web/app/(marketing)/opengraph-image/route.tsx:30`;
    const rows: Array<[string, string, string, string]> = [["css/x.css", ".in", "color", cite]];
    const uses = new Map([[copperKey("css/x.css", ".in", "color"), { nonApp: false }]]);
    expect(pictureOffences(rows, uses, docs)).toEqual([]);
  });

  it("(a) the picture guard fails a rule outside a figure, a non-app copper, a missing cite, and a bare figure", () => {
    const cite = `${PICTURE} @ apps/web/app/(marketing)/opengraph-image/route.tsx:30`;
    const inFigure = [
      new JSDOM('<figure role="img" aria-label="Screen."><p class="in">x</p></figure>').window
        .document,
    ];
    const one = (tag: string, nonApp: boolean, docs: Document[], sel = ".in") =>
      pictureOffences(
        [["css/x.css", sel, "color", tag]],
        new Map([[copperKey("css/x.css", sel, "color"), { nonApp }]]),
        docs,
      );
    // outside a figure
    const outside = [new JSDOM('<p class="out">x</p>').window.document];
    expect(one(cite, false, outside, ".out").join()).toContain("outside a figure");
    // a data- look-alike and a blank label are not a figure
    const fake = [
      new JSDOM('<figure data-role="img" aria-label="S"><p class="in">x</p></figure>').window
        .document,
    ];
    expect(one(cite, false, fake).join()).toContain("outside a figure");
    const blank = [
      new JSDOM('<figure role="img" aria-label="  "><p class="in">x</p></figure>').window.document,
    ];
    expect(one(cite, false, blank).join()).toContain("outside a figure");
    // a copper the app does not use
    expect(one(cite, true, inFigure).join()).toContain("not the app's copper");
    // no cite, or a cite to a line with no copper
    expect(one(PICTURE, false, inFigure).join()).toContain("no app file:line");
    expect(
      one(
        `${PICTURE} @ apps/web/app/(marketing)/opengraph-image/route.tsx:1`,
        false,
        inFigure,
      ).join(),
    ).toContain("no app file:line");
  });

  it("(a) the picture rows that stand are valid", () => {
    const docs = siteHtml().map((p) => new JSDOM(p.html).window.document);
    const byKey = new Map(copperScan().uses.map((u) => [u.key, { nonApp: u.nonApp }]));
    expect(pictureOffences(COPPER_ALLOW, byKey, docs)).toEqual([]);
  });

  it("(a) the brand-colour picture rows stand: figure scope, a copper token, no status, no cite", () => {
    const docs = siteHtml().map((p) => new JSDOM(p.html).window.document);
    expect(brandPictureOffences(COPPER_ALLOW, brandUses(), docs, aliasNames(COPPER_ALLOW))).toEqual(
      [],
    );
  });

  it("(a) the copper aliases: 5 rows, each a copper token, each reader tagged (SA-1203 A16)", () => {
    expect(aliasNames(COPPER_ALLOW).size).toBe(COPPER_ALIAS_COUNT);
    expect(aliasOffences(COPPER_ALLOW, copperSources(), aliasTexts())).toEqual([]);
  });

  it("(a) no copper key is read twice with a different value (SA-1203 A20 R8)", () => {
    expect(copperScan().dupes).toEqual([]);
  });

  it("(a) the site css and html read clean: no unknown at-rule, nested rule, escape or unread container (R2, R3, M1-M3)", () => {
    expect(KNOWN_AT_RULES).toHaveLength(5);
    expect(LEGIT_REDS).toHaveLength(1);
    const realHash = (f: string) => sha256Of(fs.readFileSync(path.join(WEB, f)));
    expect(applyLegitReds(siteRead().problems, realHash)).toEqual([]);
  });

  it("(a) the source census is pinned: a new source is a reviewed diff, never a re-pin (R4, A24 item 7)", () => {
    expect(siteRead().census).toEqual(CENSUS_NOW);
  });

  it("(a) R7 over every site script: the one vendored exclusion is by path and full hash (A21)", () => {
    expect(R7_EXCLUDED).toHaveLength(1);
    expect(r7Reds(siteJsFiles())).toEqual([]);
    const names = siteJsFiles().map((f) => f.name);
    for (const n of ["gsap.min.js", "ScrollTrigger.min.js", "SplitText.min.js"])
      expect(names).toContain("public/site/js/vendor/" + n);
  });

  describe("planted vendor fixtures (SA-1203 A21)", () => {
    const real = () => siteJsFiles();
    it("a one-byte edit of the vendored file is red", () => {
      const files = real().map((f) =>
        f.name === SPLITTEXT_PATH ? { ...f, bytes: Buffer.concat([f.bytes, Buffer.from(" ")]) } : f,
      );
      expect(r7Reds(files).join()).toContain("rule=r7-vendor-pin");
    });
    it("a second name-building match is red even with the hash unchanged", () => {
      const bytes = Buffer.from(
        real()
          .find((f) => f.name === SPLITTEXT_PATH)!
          .bytes.toString("utf8") + ';m.style.setProperty("--"+y,1)',
      );
      const files = [{ name: SPLITTEXT_PATH, bytes }];
      const pin = [{ path: SPLITTEXT_PATH, sha256: sha256Of(bytes) }];
      expect(r7Reds(files, pin).join()).toContain("rule=r7-vendor-pin");
    });
    it("a new vendor file with a name-building call is red; gsap and ScrollTrigger are green", () => {
      const bytes = Buffer.from('el.style.setProperty("--"+x, 1)');
      const files = [...real(), { name: "public/site/js/vendor/other.min.js", bytes }];
      const reds = r7Reds(files);
      expect(reds.join()).toContain("other.min.js");
      expect(reds.join()).toContain("rule=r7-runtime-name");
      expect(reds.join()).not.toMatch(/gsap\.min|ScrollTrigger\.min/);
    });
  });

  describe("planted source fixtures (SA-1203 A24 plants 0-26)", () => {
    const withHome = (f: (html: string) => string): SourceInputs => {
      const inp = realInputs();
      return {
        ...inp,
        pages: inp.pages.map((p) => (p.name === "home.html" ? { ...p, html: f(p.html) } : p)),
      };
    };
    const inject = (snippet: string) =>
      withHome((h) =>
        h.includes("</body>") ? h.replace("</body>", snippet + "</body>") : h + snippet,
      );
    const withSheet = (file: string, add: string): SourceInputs => {
      const inp = realInputs();
      return {
        ...inp,
        sheets: inp.sheets.map((s) => (s.path.endsWith(file) ? { ...s, text: s.text + add } : s)),
      };
    };
    const withSvg = (file: string, f: (t: string) => string): SourceInputs => {
      const inp = realInputs();
      return {
        ...inp,
        svgs: inp.svgs.map((s) => (s.path.endsWith(file) ? { ...s, text: f(s.text) } : s)),
      };
    };
    const rules = (inp: SourceInputs) => auditSources(inp).join("\n");
    const COPPER = "#B5683A";

    it("0: the untouched tip is green with every pin equal", () => {
      expect(auditSources(realInputs())).toEqual([]);
    });
    it("1: an upper-case STYLE attribute with copper is red", () => {
      expect(rules(inject(`<p STYLE="color:${COPPER}">x</p>`))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("2: spaces around = in a style attribute are red", () => {
      expect(rules(inject(`<p style = "color:${COPPER}">x</p>`))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("3: an unquoted style attribute is red", () => {
      expect(rules(inject(`<p style=color:${COPPER}>x</p>`))).toContain("rule=copper-not-allowed");
    });
    it("4: p/style= is a style attribute to the parser, and red", () => {
      expect(rules(inject(`<p/style="color:${COPPER}">x</p>`))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("5: a numeric entity with no semicolon is decoded, and red", () => {
      expect(rules(inject('<p style="color:&#35B5683A">x</p>'))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("6: <style > and <STYLE> blocks with copper are red", () => {
      const out = auditSources(
        inject(`<style >.zz{color:${COPPER}}</style ><STYLE>.yy{color:${COPPER}}</STYLE>`),
      );
      expect(
        out.filter((r) => r.includes("rule=copper-not-allowed")).length,
      ).toBeGreaterThanOrEqual(2);
    });
    it("7: a CSS escape outside a string in a sheet is red", () => {
      expect(rules(withSheet("css/home.css", ".zz{color:var(\\2d\\2drf-copper)}"))).toContain(
        "rule=escape-outside-string",
      );
    });
    it("8: a CSS escape in a style attribute is red", () => {
      expect(rules(inject('<p style="color:#\\42 5683A">x</p>'))).toContain(
        "rule=escape-outside-string",
      );
    });
    it("9: copper added to the palette block is a palette mismatch", () => {
      const inp = withHome((h) =>
        h.replace(
          /(<style id="brand-tokens">[\s\S]*?)(<\/style>)/,
          "$1h1{color:var(--rf-copper)}$2",
        ),
      );
      expect(rules(inp)).toContain("rule=palette-content-mismatch");
    });
    it("10: one changed palette value is a palette mismatch", () => {
      const inp = withHome((h) =>
        h.replace(
          /(<style id="brand-tokens">[^#]*#)([0-9a-fA-F])/,
          (_m, a, d) => a + (d === "0" ? "1" : "0"),
        ),
      );
      expect(rules(inp)).toContain("rule=palette-content-mismatch");
    });
    it("11: a new svg file with a copper fill is red", () => {
      const inp = realInputs();
      inp.svgs.push({
        path: "public/site/img/hero.svg",
        text: `<svg xmlns="http://www.w3.org/2000/svg"><path fill="${COPPER}" d="M0 0"/></svg>`,
      });
      expect(rules(inp)).toContain("rule=svg-colour-attr");
    });
    it("12: an inline path with a copper fill is red", () => {
      expect(rules(inject(`<svg><path fill="${COPPER}" d="M0 0"/></svg>`))).toContain(
        "rule=svg-colour-attr",
      );
    });
    it("13: an inline stop-color is red", () => {
      const s = `<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#b5683a"/></linearGradient></defs></svg>`;
      expect(rules(inject(s))).toContain("rule=svg-colour-attr");
    });
    it("14: animate and set to a copper colour are red", () => {
      const s = `<svg><rect><animate attributeName="fill" to="${COPPER}"/></rect><rect><set attributeName="fill" to="${COPPER}"/></rect></svg>`;
      const out = auditSources(inject(s));
      expect(out.filter((r) => r.includes("rule=svg-colour-attr")).length).toBeGreaterThanOrEqual(
        2,
      );
    });
    it("15: a template holding a copper style is red under the copper rule", () => {
      expect(rules(inject(`<template><p style="color:${COPPER}">x</p></template>`))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("16: a style inside a brand svg file is an unread container", () => {
      const inp = withSvg("img/brand/symbol.svg", (t) =>
        t.replace("</svg>", `<style>.a{fill:${COPPER}}</style></svg>`),
      );
      expect(rules(inp)).toContain("rule=unread-container");
    });
    it("17: a style inside an inline svg is an unread container", () => {
      expect(rules(inject(`<svg><style>.a{fill:${COPPER}}</style></svg>`))).toContain(
        "rule=unread-container",
      );
    });
    it("18: a noscript holding a copper style is an unread container", () => {
      expect(rules(inject(`<noscript><p style="color:${COPPER}">x</p></noscript>`))).toContain(
        "rule=unread-container",
      );
    });
    it("19: a link outside the census and a data: link are unread containers", () => {
      const a = auditSources(inject('<link rel="stylesheet" href="/site/css/evil.css">'));
      const b = auditSources(inject('<link rel="stylesheet" href="data:text/css,a{}">'));
      expect(a.join("\n")).toContain("form=link-stylesheet");
      expect(b.join("\n")).toContain("form=data-url");
      expect(a.join("\n") + b.join("\n")).toContain("rule=unread-container");
    });
    it("20: an iframe srcdoc is an unread container", () => {
      expect(rules(inject('<iframe srcdoc="&lt;p&gt;x&lt;/p&gt;"></iframe>'))).toContain(
        "rule=unread-container",
      );
    });
    it("21: a non-palette hex in symbol.svg is off the logo palette", () => {
      const inp = withSvg("img/brand/symbol.svg", (t) =>
        t.replace(/(fill|stroke)="#[0-9a-fA-F]{3,6}"/, '$1="#123456"'),
      );
      expect(rules(inp)).toContain("rule=logo-off-palette");
    });
    it("22: one extra inline script trips the script-count pin", () => {
      expect(rules(inject("<script>var a=1</script>"))).toContain("rule=inline-script-count");
    });
    it("23: a quoted backslash escape is green", () => {
      expect(auditSources(withSheet("css/home.css", '.zz::after{content:"\\201C"}'))).toEqual([]);
    });
    it("24: a palette block equal by parse with other whitespace is green", () => {
      const inp = withHome((h) =>
        h.replace(
          /(<style id="brand-tokens">)([\s\S]*?)(<\/style>)/,
          (_m, a, b, c) => a + "\n  " + b.replace(/\{/g, " {\n ").replace(/;/g, " ;\n ") + "\n" + c,
        ),
      );
      expect(auditSources(inp)).toEqual([]);
    });
    it("25: the unchanged copper logos are green", () => {
      const out = auditSources(realInputs()).join("\n");
      expect(out).not.toContain("symbol.svg");
      expect(out).not.toContain("routeflow-mark-reversed.svg");
      const files = realInputs().svgs.map((s) => s.path);
      expect(files).toContain("public/site/img/brand/symbol.svg");
      expect(files).toContain("public/site/img/routeflow-mark-reversed.svg");
    });
    const dataSvg = (inner: string) =>
      `.zz{background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27%3E${inner}%3C/svg%3E")}`;
    it("27: copper in a percent-encoded data-url svg is red", () => {
      const css = dataSvg("%3Cpath fill=%27%23B5683A%27/%3E");
      expect(rules(withSheet("css/home.css", css))).toContain("rule=copper-in-data-url");
    });
    it("28: a base64 data url is an unread container", () => {
      const css = '.zz{background:url("data:image/svg+xml;base64,PHN2Zy8+")}';
      expect(rules(withSheet("css/home.css", css))).toContain("rule=unread-container");
    });
    it("29: a data:image/png url is an unread container", () => {
      const css = '.zz{background:url("data:image/png,abc")}';
      expect(rules(withSheet("css/home.css", css))).toContain("rule=unread-container");
    });
    it("30: a style attribute inside a decoded data-url svg is an unread container", () => {
      const css = dataSvg("%3Cpath style=%27fill:red%27/%3E");
      expect(rules(withSheet("css/home.css", css))).toContain("rule=unread-container");
    });
    it("31: a copper style block inside a template is red under the copper rule", () => {
      expect(rules(inject(`<template><style>.zz{color:${COPPER}}</style></template>`))).toContain(
        "rule=copper-not-allowed",
      );
    });
    it("32: a one-byte edit of favicon.svg is red by the hash", () => {
      const inp = withSvg("img/brand/favicon.svg", (t) => t + "\n");
      expect(rules(inp)).toContain("rule=legit-red-hash");
    });
    it("33: an eighth colourless css data url is a census red only", () => {
      const out = auditSources(withSheet("css/home.css", dataSvg("%3Crect width=%271%27/%3E")));
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((r) => r.includes("rule=census-pin"))).toBe(true);
    });
    it("26: a ninth palette-hex logo in img/brand is a census red only", () => {
      const inp = realInputs();
      inp.svgs.push({
        path: "public/site/img/brand/ninth.svg",
        text: `<svg xmlns="http://www.w3.org/2000/svg"><path fill="${COPPER}" d="M0 0"/></svg>`,
      });
      const out = auditSources(inp);
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((r) => r.includes("rule=census-pin"))).toBe(true);
    });
  });

  describe("planted reader fixtures (SA-1203 A20 X1-X8)", () => {
    const read1 = (css: string) => readCss(css, "css/x.css");
    const keysOf = (css: string) =>
      copperScan(read1(css).rules.map(toCopper)).uses.map((u) => u.key);
    const allowedKeys = () => COPPER_ALLOW.map(([x, sel, pr]) => copperKey(x, sel, pr));
    it("X1: @layer is an unknown at-rule", () => {
      expect(read1("@layer x{.zz{color:#B5683A}}").problems.join()).toContain(
        "unknown at-rule @layer",
      );
    });
    it("X2: @container is an unknown at-rule", () => {
      const css = "@container (min-width:1px){.zz{color:var(--rf-copper)}}";
      expect(read1(css).problems.join()).toContain("unknown at-rule @container");
    });
    it("X3: copper in a @keyframes frame is a use that needs its own row", () => {
      const keys = keysOf("@keyframes k{50%{color:var(--rf-copper)}}");
      expect(keys).toContain("css/x.css :: @keyframes k :: 50% :: color");
      expect(allowedKeys()).not.toContain("css/x.css :: @keyframes k :: 50% :: color");
    });
    it("X4: a nested style rule is a problem", () => {
      const css = ".zz{ .yy{color:var(--rf-copper)} }";
      expect(read1(css).problems.join()).toContain("nested rule at css/x.css");
    });
    it("X5: a ; inside a url string does not hide the copper after it", () => {
      const css = '.zz{background:url("a;b.png");color:VAR(--rf-copper)}';
      const keys = keysOf(css);
      expect(keys).toContain("css/x.css :: .zz :: color");
      expect(allowedKeys()).not.toContain("css/x.css :: .zz :: color");
    });
    it("X6: VAR(--rf-paid) makes the rule a status rule, and a picture row on it is red", () => {
      const rule = toCopper(
        read1(".zz{color:VAR(--rf-copper);border-color:VAR(--rf-paid)}").rules[0],
      );
      expect(isStatusRule(rule)).toBe(true);
      const d = new JSDOM('<figure role="img" aria-label="Screen."><i class="zz">x</i></figure>')
        .window.document;
      const row: [string, string, string, string] = ["css/x.css", ".zz", "color", PICTURE_BRAND];
      expect(brandPictureOffences([row], brandUses([rule]), [d]).join()).toContain("status rule");
    });
    it("X7: a name only in fallback text is not a read, so the alias is dead", () => {
      const rows: Array<[string, string, string, string]> = [
        ["css/x.css", ":root", "--a0", COPPER_ALIAS],
      ];
      const rules = read1(":root{--a0:var(--rf-copper)} .r{color:var(--rf-link, --a0)}").rules.map(
        toCopper,
      );
      expect(aliasOffences(rows, rules, []).join()).toContain("a dead alias");
      const nested = read1(
        ":root{--a0:var(--rf-copper)} .r{color:var(--rf-link, var(--a0))}",
      ).rules;
      expect(aliasOffences(rows, nested.map(toCopper), []).join()).toContain("untagged reader");
    });
    it("X8: a script that builds a custom-property name at run time is red", () => {
      for (const text of [
        'el.style.setProperty("--" + x, v)',
        "el.style.setProperty(`--${x}`, v)",
        "k = 'a' + '--' + x",
      ])
        expect(dynamicPropertyNames(text)).not.toEqual([]);
      expect(dynamicPropertyNames('el.style.setProperty("--a0", v)')).toEqual([]);
    });
  });

  it("(a) strict tags: only R17's jobs, the token definition, A9 and A16; none pending", () => {
    const n = (t: string) => COPPER_ALLOW.filter((r) => r[3] === t).length;
    const jobs = COPPER_ALLOW.filter((r) => (R17_JOBS as readonly string[]).includes(r[3])).length;
    expect(n(PENDING_OWNER)).toBe(0);
    expect(jobs + n(TOKEN_DEF) + n(PICTURE_BRAND) + n(COPPER_ALIAS)).toBe(COPPER_ALLOW.length);
    expect([n(TOKEN_DEF), n(PICTURE_BRAND), n(COPPER_ALIAS)]).toEqual([10, 10, 5]);
  });

  describe("planted brand-picture and alias fixtures (SA-1203 A9, A16)", () => {
    type Row = [string, string, string, string];
    const doc = () =>
      new JSDOM(
        '<figure role="img" aria-label="Screen."><i class="in paid">x</i></figure><p class="out">x</p>',
      ).window.document;
    const A9 = (sel: string, prop = "color"): Row => ["css/x.css", sel, prop, PICTURE_BRAND];
    const rule1 = (sel: string, value: string, prop = "color"): CopperRule => ({
      source: "css/x.css",
      selectors: [sel],
      decls: { [prop]: value },
    });
    const usesOf = (...rules: CopperRule[]) => brandUses(rules);
    const MEDIA = "@media (min-width:1px)";
    const inMedia = (r: CopperRule): CopperRule => ({ ...r, at: MEDIA });
    const HEX = "#" + COPPER_HEXES[0];
    it("accepts a copper-token use inside a figure", () => {
      const u = usesOf(rule1(".in", "var(--rf-copper)"));
      expect(brandPictureOffences([A9(".in")], u, [doc()])).toEqual([]);
    });
    it("P-A9a: the A9 tag outside a figure is red", () => {
      const u = usesOf(rule1(".out", "var(--rf-copper)"));
      expect(brandPictureOffences([A9(".out")], u, [doc()]).join()).toContain("outside a figure");
    });
    it("P-A9b: the A9 tag with a typed copper hex is red", () => {
      const u = usesOf(rule1(".in", HEX));
      expect(brandPictureOffences([A9(".in")], u, [doc()]).join()).toContain("typed colour");
    });
    it("P-A9b2: a typed hex in a later @media rule with the same key is red", () => {
      const u = usesOf(rule1(".in", "var(--rf-copper)"), inMedia(rule1(".in", HEX)));
      expect(brandPictureOffences([A9(".in")], u, [doc()]).join()).toContain("typed colour");
    });
    it("P-A9b3: a typed hex read from real css text, in an @media block, is red", () => {
      const css = ".in{color:var(--rf-copper)} @media (min-width:1px){.in{color:" + HEX + "}}";
      const rules = cssRulesOf(css, "css/x.css");
      const u = usesOf(...rules);
      expect(brandPictureOffences([A9(".in")], u, [doc()]).join()).toContain("typed colour");
    });
    it("P-A9c: the A9 tag on a status-like rule is red, through isStatusRule", () => {
      const u = usesOf(rule1(".in.paid", "var(--rf-copper)"));
      expect(brandPictureOffences([A9(".in.paid")], u, [doc()]).join()).toContain("status rule");
      const ok = usesOf(rule1(".in", "var(--rf-copper)"));
      expect(brandPictureOffences([A9(".in")], ok, [doc()])).toEqual([]);
    });
    it("P-A6: the A9 tag on a definition is red", () => {
      const u = usesOf(rule1(".in", "var(--rf-copper)", "--x"));
      expect(brandPictureOffences([A9(".in", "--x")], u, [doc()]).join()).toContain("a definition");
    });
    it("an upper-case VAR( alias read counts as a copper-token read", () => {
      const u = usesOf(rule1(":root", "var(--rf-copper)", "--a0"), rule1(".in", "VAR(--a0)"));
      expect(brandPictureOffences([A9(".in")], u, [doc()], new Set(["--a0"]))).toEqual([]);
      // custom property names stay case-sensitive: --A0 is not the alias --a0
      const v = usesOf(rule1(":root", "var(--rf-copper)", "--A0"), rule1(".in", "VAR(--A0)"));
      expect(brandPictureOffences([A9(".in")], v, [doc()], new Set(["--a0"])).join()).toContain(
        "not var(--rf-copper",
      );
    });

    it("P-A18a: a typed hex in an @media duplicate is a new use that is not on the allow-list", () => {
      const keys = copperScan([inMedia(rule1(".in", HEX))]).uses.map((u) => u.key);
      expect(keys).toContain("css/x.css :: " + MEDIA + " :: .in :: color");
      const allowed = COPPER_ALLOW.map(([x, sel, pr]) => copperKey(x, sel, pr));
      expect(keys.filter((k) => !allowed.includes(k) && k.startsWith("css/x.css"))).toHaveLength(1);
    });
    it("P-A18b: VAR(--rf-copper) in an untagged rule is a copper use that is not allowed", () => {
      const keys = copperScan([rule1(".zz", "VAR(--rf-copper)")]).uses.map((u) => u.key);
      expect(keys).toContain("css/x.css :: .zz :: color");
    });
    const allowedKeys = () => COPPER_ALLOW.map(([x, sel, pr]) => copperKey(x, sel, pr));
    it("P-A19a: base-rule copper on .sp-all, outside the @media, is a separate key that is not allowed", () => {
      const base: CopperRule = {
        source: "css/home.css",
        selectors: [".sp-all"],
        decls: { color: "var(--rf-link)" },
      };
      const keys = copperScan([base]).uses.map((u) => u.key);
      expect(keys).toContain("css/home.css :: .sp-all :: color");
      expect(allowedKeys()).not.toContain("css/home.css :: .sp-all :: color");
      expect(allowedKeys()).toContain(HOME_MQ + " :: .sp-all :: color");
    });
    it("P-A19b: an upper-case typed copper hex in home.css is a copper use that is not allowed", () => {
      const r: CopperRule = {
        source: "css/home.css",
        selectors: [".zz"],
        decls: { color: "#" + COPPER_HEXES[0].toUpperCase() },
      };
      const keys = copperScan([r]).uses.map((u) => u.key);
      expect(keys).toContain("css/home.css :: .zz :: color");
      expect(allowedKeys()).not.toContain("css/home.css :: .zz :: color");
    });
    it("P-A18c: the same key with a different value is a duplicate; with the same value, one use", () => {
      const diff = copperScan([rule1(".in", "var(--rf-copper)"), rule1(".in", HEX)]);
      expect(diff.dupes).toEqual(["css/x.css :: .in :: color (duplicate key, different value)"]);
      const same = copperScan([rule1(".in", "var(--rf-copper)"), rule1(".in", "var(--rf-copper)")]);
      expect(same.dupes).toEqual([]);
      expect(same.uses.filter((u) => u.key === "css/x.css :: .in :: color")).toHaveLength(1);
    });

    const def = (prop: string, value: string): CopperRule => ({
      source: "css/x.css",
      selectors: [":root"],
      decls: { [prop]: value },
    });
    const reader = (sel: string, value: string, prop = "color"): CopperRule =>
      rule1(sel, value, prop);
    const AL = (prop: string): Row => ["css/x.css", ":root", prop, COPPER_ALIAS];
    const LINK_ROW = (sel: string): Row => ["css/x.css", sel, "color", R17_JOBS[6]];
    // five aliases, each with one tagged link reader: a green fixture
    const fixture = () => {
      const rows: Row[] = [];
      const rules: CopperRule[] = [];
      for (let i = 0; i < COPPER_ALIAS_COUNT; i++) {
        const prop = "--a" + i;
        rows.push(AL(prop), LINK_ROW(".r" + i));
        rules.push(def(prop, i % 2 ? "var(--rf-accent)" : "var(--rf-copper-dark)"));
        rules.push(reader(".r" + i, "var(" + prop + ")"));
      }
      return { rows, rules };
    };
    it("accepts five tagged aliases with tagged readers", () => {
      const f = fixture();
      expect(aliasOffences(f.rows, f.rules, [])).toEqual([]);
    });
    it("P-A1: an untagged reader is red", () => {
      const f = fixture();
      f.rules.push(reader(".u", "var(--a0)", "background"));
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("untagged reader");
    });
    it("P-A1b: a reader in a script or page text is red", () => {
      const f = fixture();
      const t = [{ name: "x.js", text: "s.color='var(--a0)'" }];
      expect(aliasOffences(f.rows, f.rules, t).join()).toContain("untagged reader in x.js");
    });
    it("P-A1c: a script that names the alias without var( is red", () => {
      const f = fixture();
      for (const text of [
        'cs.getPropertyValue("--a0")',
        'el.style.setProperty("--a0", "x")',
        "const k = '--a0'",
      ])
        expect(aliasOffences(f.rows, f.rules, [{ name: "x.js", text }]).join()).toContain(
          "untagged reader in x.js",
        );
    });
    it("P-A1d: an upper-case VAR( reader is red", () => {
      const f = fixture();
      f.rules.push(reader(".u", "VAR(--a0)", "background"));
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("untagged reader");
    });
    it("P-A2: a tagged second-level alias goes red only through its own untagged reader", () => {
      // --a4 is a tagged alias that reads --a0 (a tagged definition, so a fine reader of --a0)
      const f = fixture();
      f.rules[8] = def("--a4", "var(--a0)");
      const green = aliasOffences(f.rows, f.rules, []);
      expect(green).toEqual([]);
      // now --a4's own reader is untagged; --a0 and its link reader are unchanged
      const rows = f.rows.filter((r) => !(r[1] === ".r4"));
      const red = aliasOffences(rows, f.rules, []);
      expect(red.join()).toContain(":: --a4 (untagged reader: css/x.css :: .r4 :: color)");
      expect(red.filter((m) => m.includes(":: --a0 ("))).toEqual([]);
    });
    it("P-A3: an alias with a typed hex is red", () => {
      const f = fixture();
      f.rules[0] = def("--a0", HEX);
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("value is not a copper token");
    });
    it("P-A3b: a typed hex in a later @media definition of the alias is red", () => {
      const f = fixture();
      f.rules.push(def("--a0", HEX));
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("value is not a copper token");
      const css = ":root{--a0:var(--rf-copper)} @media (min-width:1px){:root{--a0:" + HEX + "}}";
      const g = fixture();
      g.rules[0] = cssRulesOf(css, "css/x.css")[0];
      g.rules.push(cssRulesOf(css, "css/x.css")[1]);
      expect(g.rules[g.rules.length - 1].at).toBe(MEDIA);
      expect(aliasOffences(g.rows, g.rules, []).join()).toContain("value is not a copper token");
    });
    it("P-A4: an alias with no readers is red", () => {
      const f = fixture();
      f.rules.splice(1, 1);
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("a dead alias");
    });
    it("P-A5: a sixth alias row breaks the count pin", () => {
      const f = fixture();
      f.rows.push(AL("--a5"), LINK_ROW(".r5"));
      f.rules.push(def("--a5", "var(--rf-copper)"), reader(".r5", "var(--a5)"));
      expect(aliasOffences(f.rows, f.rules, []).join()).toContain("not 5");
    });
  });

  it("(a) every allow-list row carries exactly one allowed tag, none pending", () => {
    const bad = COPPER_ALLOW.filter(([, , , tag]) => !isAllowedTag(tag));
    expect(bad.map(([s, sel, p]) => copperKey(s, sel, p))).toEqual([]);
  });

  it("(b) no status rule, and no status-named property, references copper", () => {
    const { uses } = copperScan();
    expect(
      uses.filter((u) => isStatusRule(u.rule) || STATUS_WORDS.test(u.prop)).map((u) => u.key),
    ).toEqual([]);
  });

  it("(b) the status rules are found by selector or by status token", () => {
    const { rules } = copperScan();
    const find = (sel: string) => rules.find((r) => r.selectors.includes(sel));
    expect(find(".a-pill--bad")).toBeDefined();
    expect(find(".rfw-tk path")).toBeDefined();
    expect(isStatusRule(find(".a-pill--bad")!)).toBe(true);
    expect(isStatusRule(find(".rfw-tk path")!)).toBe(true);
    expect(isStatusRule(find(".link")!)).toBe(false);
    expect(STATUS_WORDS.test("--error-c")).toBe(true);
  });

  it("(b) the status tokens resolve to the status palette, not to copper", () => {
    const decls = Object.assign(
      {},
      ...cssRulesOf(read("public/site/graphics/rf-graphics.css")).map((r) => r.decls),
    ) as Record<string, string>;
    const status = Object.keys(decls).filter((k) => /^--rf-(paid|pending|overdue)/.test(k));
    expect(status.length).toBeGreaterThanOrEqual(6);
    for (const k of status) {
      expect(decls[k]).toMatch(/^var\(--brand-(paid|pending|overdue)-(bg|text)\)$/);
    }
  });
});
