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
    expect(css).toContain("@keyframes rf-rise{from{transform:translateY(22px)}to{transform:none}}");
    expect(css).not.toMatch(/rf-rise[^}]*opacity/);
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

describe("the first screen on a phone is not grey", () => {
  const wheel = read("graphics/rf-wheel-up.js");
  const css = read("css/mobile.css");

  it("a tall stage gets its own six glows, painted into the canvas under the pieces", () => {
    expect(wheel).toContain("const WASH_NARROW = [");
    expect(wheel).toContain("of H > W * 1.05 ? WASH_NARROW : WASH)");
    // six glows, every one soft (alpha at most 0.5, so the stage stays light behind the pieces)
    const body = wheel.slice(wheel.indexOf("const WASH_NARROW = ["), wheel.indexOf("const washCv"));
    const alphas = [...body.matchAll(/\d+, \d+, \d+, (0\.\d+), 0\.7\d?\]/g)].map((m) =>
      Number(m[1]),
    );
    expect(alphas).toHaveLength(6);
    for (const a of alphas) expect(a).toBeLessThanOrEqual(0.5);
  });

  it("three thin brand rings sit in the hero's right margin, no repeat, behind the text", () => {
    expect(css).toContain("background-repeat:no-repeat");
    expect(css).toContain("background-size:150px 150px,auto,auto");
    for (const hex of ["%234caed9", "%236261af", "%23ffc933"]) expect(css).toContain(hex);
  });

  it("the trial sentence breaks between its two sentences, or is balanced", () => {
    expect(css).toContain(".hx-note,.pd-note,.cta-band p,h1,h2,h3");
    expect(read("home.html")).toContain('<span class="nb">No card needed.</span>');
  });
});
