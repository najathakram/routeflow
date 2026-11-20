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
