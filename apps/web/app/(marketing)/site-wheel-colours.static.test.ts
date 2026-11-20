/**
 * @jest-environment node
 */
// Lane 2.2, the wheel by role (static side; the pixels are e2e 88). The wheel script types no colour and
// reads its jobs from the page; the stylesheet names only jobs that exist, draws flat, and the typed
// brand mark and the 3D object are gone. A sweep that finds nothing throws (L-202).
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const PALETTE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../packages/types/brand/palette.json"), "utf8"),
) as { color: Record<string, string> };

const names = (css: string, re: RegExp): string[] => {
  const out = [...stripCss(css).matchAll(re)].map((m) => m[1]);
  return out;
};

/** Custom properties a stylesheet defines: `--x:` in a declaration. */
const defined = (css: string): Set<string> => new Set(names(css, /(?<![\w-])(--[\w-]+)\s*:/g));

/** The properties the page head defines from the palette file (one `--brand-<key>` per colour). */
const paletteTokens = (): Set<string> =>
  new Set(Object.keys(PALETTE.color).map((k) => `--brand-${k}`));

/** Every var(--x) without a fallback that no stylesheet in `sources` (nor the palette) defines. */
export function unresolved(css: string, sources: string[]): string[] {
  const have = new Set<string>([
    ...paletteTokens(),
    ...defined(css),
    ...sources.flatMap((s) => [...defined(s)]),
  ]);
  const out = new Set<string>();
  for (const m of stripCss(css).matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    if (m[2] === ")" && !have.has(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

describe("rf-wheel-up.css names only properties that exist", () => {
  const wheelCss = read("graphics/rf-wheel-up.css");
  const sources = ["css/site.css", "graphics/rf-graphics.css"].map(read);

  it("reads the wheel's var() uses (a sweep that finds none throws)", () => {
    const uses = [...stripCss(wheelCss).matchAll(/var\(/g)].length;
    if (uses < 20) throw new Error(`expected a wheel stylesheet full of var(), found ${uses}`);
    expect(sources.every((s) => defined(s).size > 0)).toBe(true);
    expect(defined(sources[1]).size).toBeGreaterThan(30);
  });

  it("every var(--x) resolves to a property in site.css, rf-graphics.css, the palette or the file itself", () => {
    expect(unresolved(wheelCss, sources)).toEqual([]);
  });

  it("goes red on a fixture that lacks the property (what 2.1b's site.css does to --tint, --ink-2, --ink-3)", () => {
    const before =
      ".rfw--static .rfw-pin{background:var(--tint)}.x{color:var(--ink-2)}.y{color:var(--ink-3)}";
    const site = ":root{--ink:var(--rf-ink);--line:var(--rf-line)}";
    expect(unresolved(before, [site])).toEqual(["--ink-2", "--ink-3", "--tint"]);
    // a fallback keeps a var() safe, and the file's own definitions count
    expect(unresolved(".a{--k:1;color:var(--k);width:var(--missing,3px)}", [site])).toEqual([]);
    // a palette token resolves, a made-up one does not
    expect(unresolved(".a{color:var(--brand-ink)}.b{color:var(--brand-nope)}", [site])).toEqual([
      "--brand-nope",
    ]);
  });

  it("uses no old alias of site.css (the removed --tint, --ink-2, --ink-3, --b*) and no retired job name", () => {
    const text = stripCss(wheelCss);
    expect(text.match(/var\(--(?:tint|ink-[23]|b\d+)\b/g) ?? []).toEqual([]);
    expect(text.match(/var\(--rf-(?:tint|ink-[23]|brand-\d+|ok|sh-\w+)\b/g) ?? []).toEqual([]);
  });

  it("no rule for the removed mark group or the removed object", () => {
    const text = stripCss(wheelCss);
    expect(text).not.toMatch(/\.mk\b/);
    expect(text).not.toMatch(/\.rfw-tok|\.rfw-defs|\.rfw-f\b/);
  });
});

describe("rf-wheel-up.css is flat and types no palette colour", () => {
  const text = stripCss(read("graphics/rf-wheel-up.css"));

  it("no gradient, blur, drop shadow or text shadow", () => {
    expect(text).not.toMatch(/gradient\(|blur\(|drop-shadow|text-shadow/);
  });

  it("every box-shadow is the one-pixel ring or none", () => {
    const shadows = [...text.matchAll(/box-shadow\s*:\s*([^;}]*)/g)].map((m) => m[1].trim());
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.filter((v) => v !== "var(--rf-ring)" && v !== "none")).toEqual([]);
  });

  it("types none of the palette's values", () => {
    const rgb = new Set(Object.values(PALETTE.color).map((v) => v.slice(1, 7).toLowerCase()));
    const typed = [...text.matchAll(/#([0-9a-f]{3,8})(?![0-9a-f])/gi)]
      .map((m) => m[1].toLowerCase())
      .map((h) => (h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6)))
      .filter((h) => rgb.has(h));
    expect(typed).toEqual([]);
  });
});

describe("rf-wheel-up.js types no colour and draws flat", () => {
  const src = read("graphics/rf-wheel-up.js");

  it("holds no hex colour anywhere, comments included", () => {
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it("reads the eight wheel roles once at mount with getComputedStyle", () => {
    const roles = [
      "work",
      "work-2",
      "work-wall",
      "sell",
      "sell-2",
      "sell-wall",
      "focus",
      "focus-wall",
    ];
    for (const r of roles) expect(src).toContain(`--rf-wh-${r}`);
    expect(src).toContain("getComputedStyle");
  });

  it("no gradient, no shadow blur, no shadow sprite", () => {
    expect(src).not.toMatch(/createRadialGradient|createLinearGradient|shadowBlur|shadowColor/);
    expect(src).not.toMatch(
      /<radialGradient|<linearGradient|feGaussianBlur|drop-shadow|box-shadow/,
    );
    expect(src).not.toMatch(/const sprite|const DISC|const RING|const FLOOR|const shade\b/);
  });

  it("no typed mark and no 3D object: the hub draws the page's own image", () => {
    expect(src).not.toMatch(/MARKP|M0 96V34a18|M66 2l14 14l-14 14|M26 96V52a8/);
    expect(src).not.toMatch(/const FORMS|const carton|const tokenSVG|rfw-tok/);
    expect(src).toContain("brand-symbol");
    expect(src).toContain("drawImage");
    expect(src).toContain(".decode()");
    expect(src).toContain("naturalWidth");
  });
});

// ─── the still's text labels (AA, 4.5:1) ─────────────────────────────────────
// The still the script builds (staticHTML) names a piece with a text label on its own tile. Text needs 4.5:1
// against that tile; the canvas draws icons only, which need 3:1 (site-color-and-life). Every colour here is
// read from rf-graphics.css and palette.json, resolving var() chains; nothing is typed.

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every `--x:value` of a stylesheet (the first definition wins), with the palette's `--brand-<key>` added. */
function tokenTable(css: string): Map<string, string> {
  const t = new Map<string, string>();
  for (const [k, v] of Object.entries(PALETTE.color)) t.set(`--brand-${k}`, v);
  for (const m of stripCss(css).matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    if (!t.has(m[1])) t.set(m[1], m[2].trim());
  }
  return t;
}

/** A colour value (a hex or var() chain) resolved to a hex through the table; throws on anything else. */
export function resolveColour(value: string, table: Map<string, string>, depth = 0): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (!m || depth > 8) throw new Error(`cannot resolve the colour "${value}"`);
  const next = table.get(m[1]);
  if (next === undefined) throw new Error(`${m[1]} is not defined`);
  return resolveColour(next, table, depth + 1);
}

/** The value of `prop` in the rule whose selector is exactly `selector` in the stripped stylesheet. */
export function ruleValue(css: string, selector: string, prop: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "g");
  for (const m of stripCss(css).matchAll(rule)) {
    const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[1]);
    if (d) return d[1].trim();
  }
  throw new Error(`no rule "${selector}" with ${prop}`);
}

describe("the still's text labels are AA (4.5:1) on their own tile", () => {
  const wheelCss = read("graphics/rf-wheel-up.css");
  const table = tokenTable(read("graphics/rf-graphics.css"));
  const hex = (selector: string, prop: string) =>
    resolveColour(ruleValue(wheelCss, selector, prop), table);

  // the label rules and the tile each sits on: a label is on the bone tiles only; the focus tile has its icon and no
  // label (SA-1183 K1), and that pair (3:1) is held in site-home-w3.static.test.ts
  const PAIRS: Array<[string, string, string, string]> = [
    ["a label on the first bone", ".rfw-lb", ".rfw-w", "fill"],
    ["a label on the second bone", ".rfw-lb", ".rfw-w.g", "fill"],
  ];

  it.each(PAIRS)("%s", (_name, label, tile, prop) => {
    const text = hex(label, prop);
    const fill = hex(tile, "fill");
    const r = contrast(text, fill);
    // the ratio is on the log of a pass, so a drift towards the floor is visible
    console.log(`still label ${label} ${text} on ${tile} ${fill}: ${r.toFixed(2)}:1`);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  it("the resolver reads the real files and goes red on white over the old copper (4.19:1)", () => {
    expect(hex(".rfw-w", "fill").toLowerCase()).not.toBe(PALETTE.color.white.toLowerCase());
    expect(contrast(PALETTE.color.white, PALETTE.color.copper)).toBeLessThan(4.5);
    expect(() => resolveColour("var(--nope)", table)).toThrow(/not defined/);
    expect(() => ruleValue(wheelCss, ".rfw-nothing", "fill")).toThrow(/no rule/);
  });
});

describe("D-3: the focus ring on the canvas is 3 px and ink", () => {
  const src = read("graphics/rf-wheel-up.js");
  it("the ring is drawn at 3 x dpr in the ink role, for the tile in focus", () => {
    const line = src
      .split("\n")
      .find((l) => l.includes("if (focusI === w.i) { ctx.beginPath(); trace(tx, ty, n);"));
    if (!line) throw new Error("no focus ring line found in rf-wheel-up.js");
    expect(line).toContain("ctx.lineWidth = 3 * dpr");
    expect(line).toContain("ctx.strokeStyle = css(C.ink)");
    expect(src).toMatch(/\bink: [^,]*--rf-ink\b|"ink"/);
  });
});
