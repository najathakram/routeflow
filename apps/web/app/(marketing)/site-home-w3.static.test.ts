/**
 * @jest-environment node
 */
// Lane 2.3-home, the static side. K1 (the focus tile): the still and the canvas fill Payments with one token, and the
// focus piece carries its icon only. The page's own still matches the script's still. SA-1180 (2): a status colour
// marks a status and nothing else. The use-case cards carry no inline colour, and no filter recolours the end mark.
// Colours are read from the files, never typed; a sweep that finds nothing throws (L-202).
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { readServedSitePage } from "@/lib/read-site-page";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const PALETTE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../packages/types/brand/palette.json"), "utf8"),
) as { color: Record<string, string> };

type Rule = { selectors: string[]; body: string };
/** Every rule with a body of declarations, inside @media and @supports too. */
const rulesOf = (css: string): Rule[] =>
  [...stripCss(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    body: m[2] as string,
  }));

/** The wheel script's still, as the script builds it (no page: no brand name, no hub image). */
const scriptStill = (): string => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(read("graphics/rf-wheel-up.js"), ctx);
  const wheel = ctx.RFWheel as { staticHTML: () => string };
  return wheel.staticHTML();
};

/** The svg of a still, split into its pieces (a piece starts at its `rfw-ln` outline). */
const svgOf = (html: string): string => {
  const m = /<svg class="rfw-svg"[\s\S]*?<\/svg>/.exec(html);
  if (!m) throw new Error("no still svg found");
  return m[0];
};
const piecesOf = (svg: string): string[] => {
  const parts = svg.split('<path class="rfw-ln"').slice(1);
  if (parts.length !== 15) throw new Error(`expected 15 pieces, found ${parts.length}`);
  return parts;
};

describe("K1: the focus tile is one token, icon only", () => {
  const wheelCss = read("graphics/rf-wheel-up.css");
  const wheelJs = read("graphics/rf-wheel-up.js");

  it("the still's focus piece and the canvas fill read the same token", () => {
    const role = /\bfocus: "(--rf-wh-focus)"/.exec(wheelJs);
    if (!role) throw new Error("the script's focus role was not found");
    const rule = rulesOf(wheelCss).find((r) => r.selectors.includes(".rfw-w.f"));
    if (!rule) throw new Error("no .rfw-w.f rule");
    expect(rule.body).toContain(`fill:var(${role[1]})`);
    expect(rule.body).toContain(`stroke:var(${role[1]})`);
  });

  it("the focus wall colour stays a canvas wall colour: no still rule reads it", () => {
    expect(rulesOf(wheelCss).filter((r) => r.body.includes("--rf-wh-focus-wall"))).toEqual([]);
  });

  it("the script's still: nine outer pieces are named, the focus piece is not, and it keeps its icon", () => {
    const pieces = piecesOf(svgOf(scriptStill()));
    const outer = pieces.slice(0, 10);
    const focus = outer.filter((p) => / f" /.test(p));
    expect(focus).toHaveLength(1);
    expect(focus[0]).not.toContain("rfw-lb");
    expect(focus[0]).toContain('class="rfw-ic on"');
    const named = outer.filter((p) => p.includes('<text class="rfw-lb'));
    expect(named).toHaveLength(9);
  });

  it("the white icon on the copper tile is a pair of at least 3:1", () => {
    const table = new Map<string, string>();
    for (const [k, v] of Object.entries(PALETTE.color)) table.set(`--brand-${k}`, v);
    for (const m of stripCss(read("graphics/rf-graphics.css")).matchAll(
      /(?<![\w-])(--[\w-]+)\s*:\s*([^;}]+)/g,
    )) {
      if (!table.has(m[1] as string)) table.set(m[1] as string, (m[2] as string).trim());
    }
    const resolve = (v: string, depth = 0): string => {
      if (/^#[0-9a-f]{6}$/i.test(v)) return v;
      const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v.trim());
      const next = m ? table.get(m[1] as string) : undefined;
      if (!m || next === undefined || depth > 8) throw new Error(`cannot resolve ${v}`);
      return resolve(next, depth + 1);
    };
    const decl = (sel: string, prop: string): string => {
      for (const r of rulesOf(wheelCss).filter((x) => x.selectors.includes(sel))) {
        const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(r.body);
        if (m) return (m[1] as string).trim();
      }
      throw new Error(`no ${prop} in ${sel}`);
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1, 7), 16);
      const lin = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    };
    const icon = resolve(decl(".rfw-ic.on", "stroke"));
    const tile = resolve(decl(".rfw-w.f", "fill"));
    const [hi, lo] = [lum(icon), lum(tile)].sort((a, b) => b - a);
    expect(((hi as number) + 0.05) / ((lo as number) + 0.05)).toBeGreaterThanOrEqual(3);
  });

  it("the comment names the rule", () => {
    expect(wheelCss).toContain("Payments is copper, icon only, named in the legend");
  });
});

describe("the page's still is the script's still", () => {
  const page = readServedSitePage("home");
  const pageSvg = svgOf(page);
  const normal = (svg: string) =>
    svg.replace(/ aria-label="[^"]*"/, "").replace(/<image [^>]*\/>/, "");

  it("same pieces, same classes, same paths, same icons (name and hub image aside)", () => {
    expect(normal(pageSvg)).toBe(normal(svgOf(scriptStill())));
  });

  it("the hub's mark has the script's box", () => {
    const box = /<image href="\$\{sym\}" ([^>]*?) preserveAspectRatio/.exec(
      read("graphics/rf-wheel-up.js"),
    );
    if (!box) throw new Error("the script's hub image was not found");
    const img = /<image [^>]*\/>/.exec(pageSvg);
    if (!img) throw new Error("the page still has no hub image");
    for (const part of (box[1] as string).split(" ")) expect(img[0]).toContain(part);
  });

  it("the hub is painted by its class, with no colour typed on the page", () => {
    expect(pageSvg).toContain('<circle class="rfw-hub" r="116"/>');
    expect(pageSvg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("SA-1180 (2): a status colour marks a status", () => {
  const css = read("css/home.css");
  /** The selectors of the status marks (Paid, Pending, Overdue): a pill each, and the due mark on a store's list. */
  const STATUS_MARKS = [".a-pill--ok", ".a-pill--warn", ".a-pill--bad", ".sp-m b.due"];
  const STATUS = /var\(--rf-(?:paid|pending|overdue)(?:-bg)?\)/;

  it("no paid, pending or overdue token outside the status marks", () => {
    const users = rulesOf(css).filter((r) => STATUS.test(r.body));
    if (users.length === 0) throw new Error("no rule of home.css uses a status token");
    const stray = users.flatMap((r) => r.selectors).filter((s) => !STATUS_MARKS.includes(s));
    expect(stray).toEqual([]);
  });

  it("every status mark still shows its status", () => {
    const users = rulesOf(css)
      .filter((r) => STATUS.test(r.body))
      .flatMap((r) => r.selectors);
    for (const mark of STATUS_MARKS) expect(users).toContain(mark);
  });

  it("the price change is the accent and the stock marks are text", () => {
    const body = (sel: string) =>
      rulesOf(css)
        .filter((r) => r.selectors.includes(sel))
        .map((r) => r.body)
        .join(";");
    expect(body(".c-chg b")).toContain("color:var(--rf-accent)");
    expect(body(".b-stk.ok")).toContain("color:var(--rf-text)");
    expect(body(".b-stk.lo")).toContain("color:var(--rf-text-2)");
  });
});

describe("home.html: pictures and cards by role", () => {
  const html = readServedSitePage("home");

  it("no use-case card carries an inline colour pair", () => {
    const cards = html.match(/class="inc-i"/g) ?? [];
    if (cards.length < 20) throw new Error(`expected the use-case cards, found ${cards.length}`);
    expect(html.match(/style="[^"]*--p[ci]:/g) ?? []).toEqual([]);
  });

  it("the end mark is the on-dark symbol itself: no filter recolours it", () => {
    const css = read("css/home.css");
    const marks = rulesOf(css).filter((r) => r.selectors.some((s) => s.includes(".end-mark")));
    if (marks.length === 0) throw new Error("no .end-mark rule");
    expect(marks.filter((r) => /filter/.test(r.body))).toEqual([]);
  });
});
