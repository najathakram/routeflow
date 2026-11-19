/**
 * @jest-environment node
 */
// The founder card must be as wide as the page content (1200px) and its padding must not use a
// percentage: a % padding resolves against the parent's width, so on a wide screen it squeezed the
// grid columns to ~380px each inside a 1640px card.
import * as fs from "fs";
import * as path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../../public/site/css/home-up.css"), "utf8");
const rule = css.split("\n").find((l) => l.startsWith("#founder .fd-in{")) ?? "";

// The half-gap scan (B1294). A percentage padding resolves against the parent width, and the half-gap
// of a centred column is spelled ((100% - N) / 2) or (50% - N): directly in a padding, or through a
// custom property that a padding then reads. Comments and line breaks are read out first.
const HALF_GAP = String.raw`\(\s*100%\s*-[^)]*\)\s*\/\s*2|50%\s*-\s*\d`;
const padsWithHalfGap = (raw: string): boolean => {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  if (new RegExp(`padding[^;{}]*(?:${HALF_GAP})`).test(text)) return true;
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
    if (!new RegExp(HALF_GAP).test(m[2] as string)) continue;
    if (new RegExp(String.raw`padding[^;{}]*var\(\s*${m[1]}(?![\w-])`).test(text)) return true;
  }
  return false;
};
// Every stylesheet of the site: public/site at any depth, and the frame's own.
const siteStylesheets = (): string[] => {
  const web = path.resolve(__dirname, "../..");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(web, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".css")) out.push(rel);
    }
  };
  walk("public/site");
  out.push("components/site-frame/site-frame.css");
  return out;
};

describe("founder card width", () => {
  it("is capped at the content width and centred", () => {
    expect(rule).toContain("width:min(1200px,100% - 48px)");
    expect(rule).toContain("margin-inline:auto");
    expect(rule).not.toContain("1640px");
  });

  it("pads with a fixed clamp, never a percentage of the parent", () => {
    const pad = /padding:([^;]+);/.exec(rule)?.[1] ?? "";
    expect(pad).not.toContain("%");
  });
});

describe("no-JS hero width", () => {
  const hero =
    css.split("\n").find((l) => l.includes("html:not(.js-motion) .hx-up{display:grid")) ?? "";

  it("is capped at the content width, with fixed padding", () => {
    expect(hero).toContain("width:min(1200px,100% - 48px)");
    expect(hero).not.toContain("1640px");
    expect(/padding:([^;]+);/.exec(hero)?.[1] ?? "").not.toContain("%");
  });

  it("no site stylesheet pads with a percentage half-gap", () => {
    const files = siteStylesheets();
    expect(files.length).toBeGreaterThan(10);
    for (const rel of files) {
      const text = fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
      expect(`${rel}: ${padsWithHalfGap(text)}`).toBe(`${rel}: false`);
    }
  });
});

// The scan's own fixtures (B1294): each spelling of the half-gap padding that the first version of the
// scan missed, and the clean forms it must keep passing.
describe("the half-gap scan reads every spelling", () => {
  it.each([
    ["the original spelling", ".a{padding:0 calc((100% - 1200px)/2)}"],
    ["a space after the opening parenthesis", ".a{padding-inline:calc( ( 100% - 1200px ) / 2 )}"],
    ["calc(50% - N)", ".a{padding-left:calc(50% - 600px)}"],
    [
      "a custom property holding the half-gap",
      ".a{--g:calc((100% - 1200px)/2)}.b{padding:0 var(--g)}",
    ],
    [
      "a custom property written with 50%",
      ":root{--gut:calc(50% - 600px);}.b{padding-inline:var(--gut,0)}",
    ],
    ["a rule split over lines", ".a{\n  padding:\n    0\n    calc( (100%\n - 1200px)\n / 2);\n}"],
  ])("flags %s", (_name, css) => {
    expect(padsWithHalfGap(css)).toBe(true);
  });

  it.each([
    ["a fixed clamp", ".a{padding:clamp(28px,4vw,56px)}"],
    ["a width of the content measure", ".a{width:min(1200px,100% - 48px)}"],
    ["a half-gap used for a margin only", ".a{margin-inline:calc((100% - 1200px)/2)}"],
    ["a custom property never used in a padding", ".a{--g:calc(50% - 600px);margin:var(--g)}"],
    ["a comment that names it", "/* padding:calc(50% - 600px) */.a{padding:8px}"],
  ])("passes %s", (_name, css) => {
    expect(padsWithHalfGap(css)).toBe(false);
  });

  it("walks stylesheets outside css/ and graphics/ too", () => {
    const files = siteStylesheets();
    expect(files).toContain("components/site-frame/site-frame.css");
    expect(files.some((f) => f.startsWith("public/site/css/"))).toBe(true);
    expect(files.some((f) => f.startsWith("public/site/graphics/"))).toBe(true);
    expect(files.every((f) => f.endsWith(".css"))).toBe(true);
  });
});
