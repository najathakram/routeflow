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

  it("the comment names the rule", () => {
    expect(wheelCss).toContain("Payments is copper, icon only, named in the legend");
  });
});

describe("the page's still is the script's still", () => {
  const page = readServedSitePage("home");
  const pageSvg = svgOf(page);
  /** The brand name is the only thing the page fills in; the rest of the label must match piece for piece. */
  const normal = (svg: string) =>
    svg
      .replace(/ aria-label="The [^"]*? wheel:/, ' aria-label="The wheel:')
      .replace(/<image [^>]*\/>/, "");

  it("a page label that drops a piece name is caught (fixture)", () => {
    expect(pageSvg).toContain("payments, ");
    const dropped = pageSvg.replace("payments, ", "");
    expect(normal(dropped)).not.toBe(normal(svgOf(scriptStill())));
  });

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
  /** The selectors of the status marks (Paid, Pending, Overdue): a pill each. */
  const STATUS_MARKS = [".a-pill--ok", ".a-pill--warn", ".a-pill--bad"];
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

  // SA-1203 A5: the change amount is ink, as R17 allows copper only in its listed jobs.
  it("the change amount and the stock marks are text", () => {
    const body = (sel: string) =>
      rulesOf(css)
        .filter((r) => r.selectors.includes(sel))
        .map((r) => r.body)
        .join(";");
    expect(body(".c-chg b")).toContain("color:var(--rf-text)");
    expect(body(".b-stk.ok")).toContain("color:var(--rf-text)");
    expect(body(".b-stk.lo")).toContain("color:var(--rf-text-2)");
  });
});

describe("SA-1185: soft is a surface, pills say their status", () => {
  const css = read("css/home.css");

  it("no color or stroke declaration in home.css reads --rf-soft", () => {
    const rules = rulesOf(css);
    if (rules.length < 100) throw new Error("expected the rules of home.css");
    const bad = rules.filter((r) =>
      /(?:^|;)\s*(?:color|stroke|fill|text-decoration-color)\s*:[^;]*--rf-soft/.test(r.body),
    );
    expect(bad.flatMap((r) => r.selectors)).toEqual([]);
  });

  /** A CSS length as px: px, rem and em (16px), clamp() by its smallest bound; null when it cannot be read. */
  const px = (v: string): number | null => {
    const t = v.trim();
    const c = /^clamp\(\s*([^,]+),/.exec(t);
    if (c) return px(c[1] as string);
    const m = /^([\d.]+)(px|rem|em)$/.exec(t);
    return m ? parseFloat(m[1] as string) * (m[2] === "px" ? 1 : 16) : null;
  };
  const largeText = (size: number, weight: number) =>
    size >= 24 || (size >= 18.66 && weight >= 700);

  it("the price change is large text, or reads the link colour where it is smaller", () => {
    const rs = rulesOf(css).filter((r) => r.selectors.includes(".c-chg b"));
    expect(rs.length).toBeGreaterThan(0);
    // The cascade in source order: each rule reads its own weight (font-weight, or the font shorthand), else the
    // one a rule before it set (a breakpoint rule that only changes the size keeps the weight above it).
    let weight = 400;
    let checked = 0;
    for (const r of rs) {
      const body = r.body;
      const short = /(?:^|[;\s])font:\s*([^;]+)/.exec(body)?.[1];
      const w =
        /font-weight:\s*(bold|\d+)/.exec(body)?.[1] ??
        (short ? /(?:^|\s)(bold|[1-9]00)(?=\s)/.exec(short)?.[1] : undefined);
      if (w !== undefined) weight = w === "bold" ? 700 : Number(w);
      const raw =
        /font-size:\s*([^;]+)/.exec(body)?.[1] ??
        (short
          ? /(?:^|\s)(clamp\([^)]*\)|[\d.]+(?:px|rem|em))(?=[\s/])/.exec(short)?.[1]
          : undefined);
      if (raw === undefined && short) throw new Error("cannot read the size in font: " + short);
      if (raw === undefined) continue;
      const size = px(raw);
      if (size === null) throw new Error("cannot read the size " + raw);
      checked += 1;
      if (!largeText(size, weight)) expect(body).toContain("--rf-link");
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the large-text rule reads rem, em and clamp, and the weight (fixtures)", () => {
    expect(px("1rem")).toBe(16);
    expect(px("clamp(1.2rem,2vw,30px)")).toBeCloseTo(19.2);
    expect(largeText(22, 700)).toBe(true);
    expect(largeText(22, 400)).toBe(false);
    expect(largeText(16, 700)).toBe(false);
    expect(largeText(24, 400)).toBe(true);
  });

  it("every status pill on the page says one of the three status words", () => {
    const html = readServedSitePage("home");
    const pills = [...html.matchAll(/class="a-pill a-pill--(ok|warn|bad)"[^>]*>([^<]*)</g)];
    if (pills.length === 0) throw new Error("no status pill on the page");
    const word = { ok: "Paid", warn: "Pending", bad: "Overdue" } as Record<string, string>;
    const wrong = pills.filter((m) => (m[2] ?? "").trim() !== word[m[1] as string]);
    expect(wrong.map((m) => `${m[1]}: ${m[2]}`)).toEqual([]);
  });
});

describe("K2: a home section takes its surface from its band class", () => {
  it("no background rule for .sl in home.css or home-color.css", () => {
    const files = ["css/home.css", "css/home-color.css"].map((f) => rulesOf(read(f)));
    if (files.some((r) => r.length < 20)) throw new Error("expected rules in both files");
    const bad = files
      .flat()
      .filter(
        (r) =>
          r.selectors.some((x) => /^(?:\.home )?\.sl$/.test(x)) &&
          /(?:^|;)\s*background(?:-color)?\s*:/.test(r.body),
      );
    expect(bad.flatMap((r) => r.selectors)).toEqual([]);
  });

  it("the section is still bone through its class", () => {
    expect(readServedSitePage("home")).toMatch(/<section class="sl band-bone" id="sell"/);
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
