/**
 * @jest-environment node
 */
// Colour and life for the site (W-1129): static pins on the ported pages in public/site (no rendering).
// What must stay true: the colour files are linked, every pill and card text stays AA on its tint,
// motion runs for everyone (owner ruling 11-03: no reduced-motion gates), pricing is untouched, and the new picture is decoration only.
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

describe("the wheel wears its colours at rest", () => {
  const js = read("graphics/rf-wheel-up.js");
  const colours = [...js.matchAll(/{ k: "[a-z]+", t: "[^"]+"[^}]*?c: "(#[0-9a-f]{6})"/g)].map(
    (m) => m[1],
  );
  const tint = (c: string, k: number) =>
    "#" +
    [1, 3, 5]
      .map((i) =>
        Math.round(255 - (255 - parseInt(c.slice(i, i + 2), 16)) * k)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  it("reads the fifteen piece colours and a rest tint", () => {
    expect(colours).toHaveLength(15);
    expect(js).toMatch(/const REST_TINT = 0.4;/);
    expect(js).toContain("Math.max(p.c, outer ? REST_TINT : REST_TINT + 0.1)");
  });

  it("the navy label and icon stay AA on every piece at rest (outer 0.4, core 0.5)", () => {
    colours.forEach((c, i) => {
      expect(ratio("#0f1b2d", tint(c, i < 10 ? 0.4 : 0.5))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("the still dial (no script) paints the same tint", () => {
    expect(js).toContain(
      'style="fill:${pastel(d.c, inner ? 0.5 : 0.4)};stroke:${pastel(d.c, inner ? 0.5 : 0.4)}"',
    );
  });
});

describe("life: the motion runs for everyone", () => {
  it.each(["css/home-color.css", "css/color-deep.css"])(
    "%s: no reduced-motion query and no switch class gate the press and scroll motion",
    (file) => {
      const css = read(file);
      expect(css).not.toMatch(/prefers-reduced-motion|html:not(.rm)|.rm/);
      expect(css).toContain(".btn:active{transform:scale(.965)}");
    },
  );

  it("the home tiles press, lift and pop in on scroll", () => {
    const css = read("css/home-color.css");
    expect(css).toContain(".home .inc-i:hover{transform:translateY(-4px)");
    expect(css).toContain("animation:rf-tile-pop linear both;animation-timeline:view()");
  });
});

describe("the colour is decoration, not a new claim", () => {
  const home = read("home.html");

  it("the use-case kicker is the same pill as the others: a tint, a dot, no bar", () => {
    const css = read("css/home-color.css");
    expect(css).not.toContain(".kick::after");
    expect(css).toMatch(/#use-cases .kick{--k-bg:#[0-9a-f]{6};--k-ink:#[0-9a-f]{6};--k-dot:/);
  });

  it("all twenty-two use-case cards carry their piece colour", () => {
    const cards =
      home.match(/<li class="inc-i" style="--pc:#[0-9a-f]{6};--pi:#[0-9a-f]{3,6}"/gi) ?? [];
    expect(cards).toHaveLength(22);
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

describe("the wash and the van stay out of the way", () => {
  it("the wheel stage is plain: no colour wash tile behind the pieces", () => {
    const css = read("css/home-color.css");
    const js = read("graphics/rf-wheel-up.js");
    expect(css).not.toContain(".rfw-cvw::after");
    expect(css).not.toContain("mix-blend-mode");
    expect(css).not.toContain("--hero-wash");
    expect(js).not.toContain("WASH");
    expect(js).not.toContain("washed(");
    expect(js).toContain("c.fillStyle = stageBg; c.fillRect(0, 0, W, H);");
    expect(read("graphics/rf-wheel-up.css")).toMatch(/\.rfw-tile\{[^}]*background:#fff\}/);
  });

  it("the van's drive-in is clipped by its band, and it only takes the corner where the rows leave room", () => {
    const css = read("css/home-color.css");
    expect(css).toContain(".home .fq{overflow-x:clip}");
    expect(css).toContain("@media (min-width:1280px){\n  .home .fq>.wrap{position:relative}");
  });
});
