/**
 * @jest-environment node
 */
// Mobile pass for the public site (W-1129): static pins on css/mobile.css and the pages that link it (no rendering).
// What must stay true: the file only ever reaches phones (it is linked with a media query), it carries no claim and no price,
// motion runs for everyone, and every colour it adds keeps the text above it AA.
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const LINKED = [
  "home",
  "product",
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
  "company",
  "contact",
  "pricing",
];
const LINK = '<link rel="stylesheet" href="/site/css/mobile.css" media="(max-width:899.98px)">';

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top: number[], alpha: number, base: number[]) =>
  base.map((v, i) => v + alpha * (top[i] - v));

describe("mobile.css only reaches phones", () => {
  it.each(LINKED)("%s links mobile.css once, with the phone media query", (page) => {
    const html = read(`${page}.html`);
    expect(html.match(/css\/mobile\.css/g)).toHaveLength(1);
    expect(html).toContain(LINK);
  });

  it("the ad landing page has its own layout and does not link it", () => {
    expect(read("landing.html")).not.toContain("mobile.css");
  });

  it("the file has no desktop breakpoint of its own and is in the sync list", () => {
    const css = read("css/mobile.css");
    expect(css).not.toMatch(/min-width/);
    const sync = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/sync-site-port.mjs"),
      "utf8",
    );
    expect(sync).toContain('"css/mobile.css"');
  });
});

describe("mobile.css is arrangement, colour and life, not a claim", () => {
  const css = read("css/mobile.css");

  it("carries no price and no words (only the pill dot is generated content)", () => {
    expect(css).not.toMatch(/\$\d/);
    const contents = css.match(/content:[^;}]*/g) ?? [];
    expect(contents.every((c) => /content:""/.test(c))).toBe(true);
  });

  it("runs for everyone: no reduced-motion query and no switch class", () => {
    expect(css).not.toMatch(/prefers-reduced-motion|html:not\(\.rm\)|\.rm\b/);
    expect(css).toContain("@supports (animation-timeline:view())");
  });

  it("the rise moves a heading, it never hides one (transform only, no opacity)", () => {
    expect(css).not.toMatch(/rf-rise[^}]*opacity/);
  });

  it("T9 R10 the phone rise moves a heading less than the gap to its next line", () => {
    const rise = /@keyframes rf-rise\{from\{transform:translateY\((\d+(?:\.\d+)?)px\)\}/.exec(css);
    if (!rise) throw new Error("rf-rise offset not found in css/mobile.css");
    // the smallest margin-top below an h2, over every rule with an `h2 +` selector (spaces around the + ignored) and the
    // pricing card's `.pfrom` line, which is the next block after a card's h2
    const gaps: number[] = [];
    for (const file of ["css/site.css", "css/mobile.css"]) {
      for (const m of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/h2\s*\+|\.pfrom/.test(m[1])) continue;
        const mt = /(?:^|;)\s*margin-top:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
        if (mt) gaps.push(Number(mt[1]));
        // the first value of a `margin:` shorthand is the top margin
        const sh = /(?:^|;)\s*margin:\s*([^;]+)/.exec(m[2]);
        if (sh) {
          const top = sh[1].trim().split(/\s+/)[0];
          const px = /^(\d+(?:\.\d+)?)px$/.exec(top);
          if (px) gaps.push(Number(px[1]));
          else if (top === "0") gaps.push(0);
          else throw new Error(`cannot compare the margin shorthand top value "${top}" in ${file}`);
        }
      }
    }
    if (!gaps.length)
      throw new Error("no h2 + / .pfrom margin-top rule found in css/site.css or css/mobile.css");
    expect(Number(rise[1]) < Math.min(...gaps)).toBe(true);
    // screen only: the file is also linked for print at narrow page widths
    const block =
      /@media screen\{[^]*?@supports \(animation-timeline:view\(\)\)\{[^]*?animation:rf-rise/.exec(
        css,
      );
    expect(block !== null).toBe(true);
  });

  it("headings balance and paragraphs avoid a stranded last word", () => {
    expect(css).toContain("text-wrap:pretty");
    expect(css).toMatch(/h1,h2,h3,[^{]*\{text-wrap:balance\}/);
  });

  it("a long sample value wraps under its label instead of running over it", () => {
    expect(css).toContain(".rfw-row{flex-wrap:wrap;row-gap:0}");
    expect(css).toContain(".rfw-row .m{white-space:normal;text-wrap:balance}");
  });

  it("the home sentence about the trial keeps its words and breaks only between its sentences", () => {
    const html = read("home.html");
    expect(html).toContain(
      '<p class="risk-h">14 days free. <span class="nb">No card needed.</span></p>',
    );
    expect(css).toContain(".nb{white-space:nowrap}");
  });
});

describe("every colour it adds keeps the text above it AA", () => {
  const WHITE = [255, 255, 255];
  const INK = [15, 27, 45];
  const NAVY = [16, 38, 77];
  const SKY = [76, 174, 217];
  const GOLD = [255, 201, 51];
  const CORAL = [229, 106, 93];

  it("the first-screen glows are at most 0.2 and 0.18 over white: the navy ink stays above 12:1", () => {
    expect(ratio(INK, over(SKY, 0.2, WHITE))).toBeGreaterThan(12);
    expect(ratio(INK, over(GOLD, 0.18, WHITE))).toBeGreaterThan(12);
  });

  it("the glows in the navy box leave the white text above 7:1", () => {
    expect(ratio(WHITE, over(SKY, 0.28, NAVY))).toBeGreaterThan(7);
    expect(ratio(WHITE, over(CORAL, 0.2, NAVY))).toBeGreaterThan(7);
  });

  it("the pricing label pill: #312f78 on #dad9f7, and the ink on the indigo band", () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    expect(ratio(hex("#312f78"), hex("#dad9f7"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(INK, hex("#eceefb"))).toBeGreaterThanOrEqual(12);
    expect(ratio(INK, hex("#e3f5f4"))).toBeGreaterThanOrEqual(12);
  });
});

describe("the first screen on a phone", () => {
  const wheel = read("graphics/rf-wheel-up.js");
  const css = read("css/mobile.css");

  it("the stage has no colour glows, on a phone or anywhere", () => {
    expect(wheel).not.toContain("WASH_NARROW");
    expect(wheel).not.toContain("const WASH = [");
  });

  it("three thin brand rings sit in the hero's right margin, no repeat, behind the text", () => {
    expect(css).toContain("background-repeat:no-repeat");
    expect(css).toContain("background-size:76px 76px,auto,auto");
    for (const hex of ["%234caed9", "%236261af", "%23ffc933"]) expect(css).toContain(hex);
  });

  it("the trial sentence breaks between its two sentences, or is balanced", () => {
    expect(css).toContain(".hx-note,.pd-note,.cta-band p,h1,h2,h3");
    expect(read("home.html")).toContain('<span class="nb">No card needed.</span>');
  });

  it("a phone never draws a wheel name under 11 px; the icon stays when the name is left out", () => {
    expect(wheel).toContain("((small ? 11 : 10.5) * dpr) / 31");
    expect(wheel).toContain("shy = small && fitN < floor");
    // a phone held sideways is small too; its icon floor is the phone's
    // a sideways phone of any size: narrow and short (land), or any window under 500 px tall (low, which a 932 px phone is)
    expect(wheel).toContain(
      "small = phone || low || !!(mctx && mctx.conditions && mctx.conditions.land);",
    );
    expect(wheel).toContain("(small ? 0.62 : 0.8) * dpr");
    expect(wheel).toContain("if (!shy)");
    expect(wheel).toContain("vis * (outer ? 1 - p.n * shown * (1 - flat) : 1)");
  });

  it("a side name that will not fit at 11 px is left out, the icon stays", () => {
    expect(wheel).toContain("drop = small && room / Math.max(1, ...ls.map(wid)) < floor11;");
    expect(wheel).toContain("if (!drop) for (let j = 0; j < ls.length; j++) ctx.fillText(");
  });

  it("on a short screen the names wait until the pieces settle", () => {
    expect(wheel).toContain("brief && tile.clientHeight < 520 ? 2.7 : 1.7");
    // only short screens: a window 500 px or taller draws exactly as before
    expect(wheel).toContain("const brief = small;");
    expect(wheel).toContain("at + late");
  });

  it("the short-screen CSS reaches a sideways phone and a wide window under 500 px only", () => {
    const css2 = read("css/home-up.css");
    const q =
      "@media (max-width:899.98px) and (max-height:599.98px) and (min-aspect-ratio:1/1),(min-width:900px) and (max-height:499.98px){";
    expect(css2.split(q)).toHaveLength(3);
    // no bare height block that would reach a laptop window
    expect(css2).not.toContain("@media (max-height:599.98px) and (min-aspect-ratio:1/1){");
  });

  it("the phone wheel and its hint sit above the browser bar", () => {
    expect(wheel).toContain("roomy = vis > low + 36");
    expect(wheel).toContain("hintAt(room)");
    expect(css).toContain(".hx-up .hx-lay{padding-block:14px 6px}");
  });
});

describe("the hover label never repeats a name the piece carries", () => {
  const wheel = read("graphics/rf-wheel-up.js");

  it("each piece records whether its own name is drawn right now (left out counts as not drawn)", () => {
    expect(wheel).toContain("p.nd = false;");
    expect(wheel).toContain("p.nd = name > 0.55 && shown === 1;");
    expect(wheel).toContain("shown = shy ? 0 : 1;");
    expect(wheel).toContain("shown = drop ? 0 : 1;");
  });

  it("the label is off for a named piece, on for an icon-only one, on hover and while it is up", () => {
    expect(wheel).toContain('tip.classList.toggle("on", !P[i].nd)');
    expect(wheel).toContain('if (tipI >= 0) tip.classList.toggle("on", !P[tipI].nd);');
  });
});
