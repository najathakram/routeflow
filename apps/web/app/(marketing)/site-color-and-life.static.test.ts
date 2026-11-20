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

describe("text stays readable on every band (AA, 4.5:1)", () => {
  const css = read("css/home-color.css") + read("css/color-deep.css");
  const PALETTE = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../packages/types/brand/palette.json"),
      "utf8",
    ),
  ).color as Record<string, string>;

  it("the kicker pill is ink on bone, or ink on white where the band is bone, with a dot", () => {
    expect(css).toContain("background:var(--rf-soft);color:var(--rf-text)");
    expect(css).toContain(
      'content:"";flex:none;width:10px;height:10px;border-radius:50%;background:var(--rf-accent)',
    );
    for (const bg of [PALETTE.bone, PALETTE.white]) {
      expect(ratio(PALETTE.ink, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the ink and the steel grey are AA on every band colour the repaint uses", () => {
    for (const band of [PALETTE.white, PALETTE.bone]) {
      expect(ratio(PALETTE.ink, band)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(PALETTE.steel, band)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(PALETTE.white, PALETTE.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("small grey text that sits on a band is the steel job colour, never the old grey", () => {
    expect(read("css/home-color.css")).toMatch(
      /\.home \.sy-list span[^{]*\{color:var\(--rf-text-2\)\}/,
    );
    expect(read("css/color-deep.css")).toMatch(/\.pd \.pd-note\{color:var\(--rf-text-2\)\}/);
  });
});

describe("the wheel wears its colours at rest", () => {
  const js = read("graphics/rf-wheel-up.js");
  const graphics = read("graphics/rf-graphics.css");
  // The wheel roles are typed once, in rf-graphics.css; the script reads them at mount (T17/T19 are e2e 88).
  const role = (name: string) => {
    const m = graphics.match(new RegExp(`--rf-wh-${name}:(#[0-9A-Fa-f]{6})`));
    if (!m) throw new Error(`--rf-wh-${name} is not typed in rf-graphics.css`);
    return m[1];
  };
  // ink, white and the focus role (var(--brand-copper)) all come from the palette file, never typed here (L-072)
  const {
    ink: INK,
    white: WHITE,
    copper: COPPER,
  } = (
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../packages/types/brand/palette.json"),
        "utf8",
      ),
    ) as { color: Record<string, string> }
  ).color;
  it("keeps the fifteen pieces and one resting focus piece", () => {
    expect(js.match(/{ k: "[a-z]+", t: "/g)).toHaveLength(15);
    expect(js).toMatch(/const REST_FOCUS = "payments";/);
    expect(js).toContain("Math.max(p.w, w.d.k === REST_FOCUS ? restF : 0, focusI === w.i ? 1 : 0)");
  });

  it("the icon stays readable on every tile at rest: ink on bone, white on ink, white on copper", () => {
    for (const bone of [role("work"), role("work-2")]) {
      expect(ratio(INK, bone)).toBeGreaterThanOrEqual(4.5);
    }
    for (const ink of [role("sell"), role("sell-2")]) {
      expect(ratio(WHITE, ink)).toBeGreaterThanOrEqual(4.5);
    }
    // the canvas draws icons only, which need 3:1; the still's text labels need 4.5:1 (site-wheel-colours)
    expect(ratio(WHITE, COPPER)).toBeGreaterThanOrEqual(3);
  });

  it("the still dial (no script) wears the same two tones a ring and the copper piece", () => {
    expect(js).toContain(
      'class="rfw-w ${inner ? "i" : "o"}${i % 2 ? " g" : ""}${d.k === REST_FOCUS ? " f" : ""}"',
    );
  });
});

describe("life: the motion runs for everyone", () => {
  it.each(["css/home-color.css", "css/color-deep.css"])(
    "%s: no reduced-motion query and no switch class gate the press and scroll motion",
    (file) => {
      const css = read(file);
      expect(css).not.toMatch(/prefers-reduced-motion|html:not\(\.rm\)|\.rm\b/);
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

  it("the use-case kicker is the same pill as the others: a fill, a dot, no bar", () => {
    const css = read("css/home-color.css");
    expect(css).not.toContain(".kick::after");
    expect(css).toContain(".home #use-cases .kick{");
    expect(css).toContain(".home #use-cases .kick::before{");
  });

  it("all twenty-two use-case cards are there and the page sets no --pc/--pi anywhere (lane 2.3-home took them out)", () => {
    const cards = home.match(/<li class="inc-i"[^>]*>/gi) ?? [];
    expect(cards).toHaveLength(22);
    expect(/--p[ci]\s*:/.test(home)).toBe(false);
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
    expect(read("graphics/rf-wheel-up.css")).toMatch(
      /\.rfw-tile\{[^}]*background:var\(--rf-white\)\}/,
    );
  });

  it("the van's drive-in is clipped by its band, and it only takes the corner where the rows leave room", () => {
    const css = read("css/home-color.css");
    expect(css).toContain(".home .fq{overflow-x:clip}");
    expect(css).toContain("@media (min-width:1280px){\n  .home .fq>.wrap{position:relative}");
  });
});
