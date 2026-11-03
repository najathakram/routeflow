/**
 * @jest-environment node
 */
// Colour and life for the site (W-1129): static pins on the ported pages in public/site (no rendering).
// What must stay true: the colour files are linked, every pill and card text stays AA on its tint,
// motion is off for reduced motion, pricing is untouched, and the new picture is decoration only.
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const INNER = [
  "product",
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
  "company",
  "contact",
];

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

describe("the colour files are linked", () => {
  it("home links home-color.css after home-up.css, once", () => {
    const html = read("home.html");
    const up = html.indexOf("/site/css/home-up.css");
    const color = html.indexOf("/site/css/home-color.css");
    expect(up).toBeGreaterThan(-1);
    expect(color).toBeGreaterThan(up);
    expect(html.match(/home-color\.css/g)).toHaveLength(1);
  });

  it.each(INNER)("%s links color-deep.css once", (page) => {
    expect(read(`${page}.html`).match(/color-deep\.css/g)).toHaveLength(1);
  });

  it("pricing is untouched by the colour work", () => {
    const html = read("pricing.html");
    expect(html).not.toContain("home-color.css");
    expect(html).not.toContain("color-deep.css");
  });

  it("the sync script copies both files, so the design source and the pages stay one thing", () => {
    const sync = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/sync-site-port.mjs"),
      "utf8",
    );
    expect(sync).toContain('"css/home-color.css"');
    expect(sync).toContain('"css/color-deep.css"');
  });
});

describe("text stays readable on every tint (AA, 4.5:1)", () => {
  const css = read("css/home-color.css") + read("css/color-deep.css");

  it("every kicker pill ink is AA on its pill", () => {
    const pairs = [...css.matchAll(/--k-bg:(#[0-9a-f]{6});--k-ink:(#[0-9a-f]{6})/gi)];
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [, bg, ink] of pairs) expect(ratio(bg, ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("the navy ink and the darker grey are AA on every field tint", () => {
    const fields = [...css.matchAll(/--fld-[a-z]+:(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThanOrEqual(5);
    for (const f of fields) {
      expect(ratio("#0f1b2d", f)).toBeGreaterThanOrEqual(4.5);
      expect(ratio("#44546b", f)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("small grey text that sits on a tint is the darker grey, never the old one", () => {
    expect(read("css/home-color.css")).toMatch(/\.home \.sy-list span[^{]*\{color:#44546b\}/);
    expect(read("css/color-deep.css")).toMatch(/\.pd \.pd-note\{color:#44546b\}/);
  });
});

describe("life: motion is for people who have not asked for less", () => {
  it.each(["css/home-color.css", "css/color-deep.css"])(
    "%s: every transition and animation is inside the no-preference query",
    (file) => {
      const css = read(file);
      const at = css.indexOf("@media (prefers-reduced-motion:no-preference)");
      expect(at).toBeGreaterThan(-1);
      const outside = css.slice(0, at);
      // keyframes are only definitions; nothing outside the query may start one
      expect(outside).not.toMatch(/(^|[;{\s])(transition|animation)\s*:/);
      expect(outside).not.toContain("animation-timeline");
    },
  );

  it("the motion rules also respect the reduce switch", () => {
    const css = read("css/home-color.css");
    expect(css).toContain("html:not(.rm) .btn:active");
    expect(css).toContain("html:not(.rm) .home .inc-i:hover");
  });
});

describe("the colour is decoration, not a new claim", () => {
  const home = read("home.html");

  it("all fourteen use-case cards carry their piece colour", () => {
    const cards =
      home.match(/<li class="inc-i" style="--pc:#[0-9a-f]{6};--pi:#[0-9a-f]{3,6}"/gi) ?? [];
    expect(cards).toHaveLength(14);
  });

  it("the FAQ delivery van is hidden from assistive tech and holds only a question mark glyph", () => {
    const m = home.match(/<svg class="fq-art"[^>]*>[\s\S]*?<\/svg>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('aria-hidden="true"');
    expect(m![0]).toContain('focusable="false"');
    const words = [...m![0].matchAll(/<text[^>]*>([^<]*)</g)].map((x) => x[1]);
    expect(words).toEqual(["?"]);
  });
});
