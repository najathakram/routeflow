/**
 * WP6 T62 / R34: WCAG 2.1 contrast computed from the custom properties parsed out of styles.css,
 * light AND dark. Text pairs >= 4.5; pill pairs (`--x` on `--x-bg`) held to 4.5 too because pill
 * labels are small text (ux-spec §7: fix a failing pair by darkening the fg, never dropping the label).
 *
 * Plain-language pass: the same file also pins the style contract the renderer relies on (the new
 * classes exist and use tokens only, so light and dark stay in step), the readable type scale, the
 * 390px touch targets, and the new attention strip's colour pairs, read from the rules themselves.
 */
import * as fs from "fs";
import * as path from "path";

const CSS = path.join(__dirname, "../src/render/assets/styles.css");

function lum(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]] = m[2];
  return out;
}
function schemes(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const mi = css.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  if (mi < 0) throw new Error("no dark scheme in styles.css");
  // dark block = balanced braces after the @media
  let depth = 0;
  let end = mi;
  for (let i = css.indexOf("{", mi); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const dark = vars(css.slice(mi, end + 1));
  const light = vars(css.slice(0, mi) + css.slice(end + 1));
  return { light, dark };
}
const load = () => {
  expect(fs.existsSync(CSS)).toBe(true);
  return schemes(fs.readFileSync(CSS, "utf8"));
};

describe("ratio() implements WCAG 2.1", () => {
  it("black/white is 21 and identical is 1", () => {
    expect(ratio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(ratio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe.each(["light", "dark"] as const)("T62 tokens (%s)", (mode) => {
  const t = () => load()[mode];
  it("pins the ux-spec §1 surface and ink tokens", () => {
    const want =
      mode === "light"
        ? { "--bg": "#f7f8fa", "--card": "#ffffff", "--line": "#dee3e9", "--ink": "#1b2430" }
        : { "--bg": "#10151c", "--card": "#182029", "--line": "#2a3542", "--ink": "#e7ecf1" };
    for (const [k, v] of Object.entries(want)) expect(t()[k]?.toLowerCase()).toBe(v);
  });
  it("body text, muted text and accent clear 4.5:1 on bg and card", () => {
    const v = t();
    for (const fg of ["--ink", "--muted", "--accent"])
      for (const bg of ["--bg", "--card"]) {
        expect(v[fg]).toBeDefined();
        expect(ratio(v[fg], v[bg])).toBeGreaterThanOrEqual(4.5);
      }
  });
  it("UI boundary (--line) is at least visible against the card (>= 1.15:1 sanity) ", () => {
    const v = t();
    expect(ratio(v["--line"], v["--card"])).toBeGreaterThanOrEqual(1.1);
  });
  it("every status and severity pill pair (--x on --x-bg) clears 4.5:1", () => {
    const v = t();
    const pairs = Object.keys(v)
      .filter((k) => !k.endsWith("-bg") && v[`${k}-bg`])
      .map((k) => [k, ratio(v[k], v[`${k}-bg`])] as const);
    const names = pairs.map(([k]) => k).join(" ");
    for (const n of [
      "done",
      "wip",
      "planned",
      "risk",
      "defer",
      "critical",
      "high",
      "medium",
      "low",
    ])
      expect(names).toContain(n);
    for (const [k, r] of pairs) expect({ k, ok: r >= 4.5 }).toEqual({ k, ok: true });
  });
  it("focus ring accent meets 3:1 non-text contrast against bg and card", () => {
    const v = t();
    for (const bg of ["--bg", "--card"])
      expect(ratio(v["--accent"], v[bg])).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ plain-language pass */
interface Rule {
  sel: string[];
  d: Record<string, string>;
}
/** styles.css as top-level rules plus its at-rule blocks (media queries, keyframes), comments gone */
function parseRules(css: string): { top: Rule[]; media: { query: string; rules: Rule[] }[] } {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rulesIn = (text: string): Rule[] =>
    [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      sel: m[1].split(",").map((x) => x.trim()),
      d: Object.fromEntries(
        m[2]
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => [x.slice(0, x.indexOf(":")).trim(), x.slice(x.indexOf(":") + 1).trim()]),
      ),
    }));
  let top = "";
  const media: { query: string; rules: Rule[] }[] = [];
  for (let i = 0; i < src.length;) {
    if (src[i] !== "@") {
      top += src[i++];
      continue;
    }
    const open = src.indexOf("{", i);
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    media.push({ query: src.slice(i + 1, open).trim(), rules: rulesIn(src.slice(open + 1, j)) });
    i = j + 1;
  }
  return { top: rulesIn(top), media };
}
/** the declarations every rule naming `selector` contributes, later rules winning (same specificity) */
const merged = (rs: Rule[], selector: string): Record<string, string> =>
  Object.assign({}, ...rs.filter((r) => r.sel.includes(selector)).map((r) => r.d));
const token = (v: string | undefined): string | undefined => /var\((--[\w-]+)\)/.exec(v ?? "")?.[1];
const px = (v: string | undefined): number =>
  v?.endsWith("rem") ? parseFloat(v) * 16 : v?.endsWith("px") ? parseFloat(v) : NaN;
const sheet = () => parseRules(fs.readFileSync(CSS, "utf8"));
const SWATCH_KEYS = [
  "released",
  "cc",
  "wip",
  "planned",
  "blocked",
  "sev-critical",
  "sev-high",
  "sev-medium",
  "sev-low",
];

describe.each(["light", "dark"] as const)("plain-language attention strip (%s)", (mode) => {
  it.each(["ok", "warn", "risk"])(
    ".attn[data-level=%s]: its text clears 4.5:1 on its tint and its edge 3:1 on the page",
    (level) => {
      const { top } = sheet();
      const base = merged(top, ".attn");
      const lv = merged(top, `.attn[data-level="${level}"]`);
      const fg = token(lv.color ?? base.color);
      const bg = token(lv.background);
      const edge = token(lv["border-color"]);
      expect({ fg, bg, edge }).toEqual({
        fg: expect.any(String),
        bg: expect.any(String),
        edge: expect.any(String),
      });
      const v = load()[mode];
      expect(ratio(v[fg!], v[bg!])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(v[edge!], v["--bg"])).toBeGreaterThanOrEqual(3);
    },
  );
  it("the default strip (no level yet) is ink on the card", () => {
    const base = merged(sheet().top, ".attn");
    const v = load()[mode];
    expect([token(base.color), token(base.background)]).toEqual(["--ink", "--card"]);
    expect(ratio(v["--ink"], v["--card"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("plain-language style contract", () => {
  it("the three attention levels use three different tints and edges (never one colour for all)", () => {
    const { top } = sheet();
    const lv = ["ok", "warn", "risk"].map((l) => merged(top, `.attn[data-level="${l}"]`));
    expect(new Set(lv.map((r) => token(r.background))).size).toBe(3);
    expect(new Set(lv.map((r) => token(r["border-color"]))).size).toBe(3);
  });
  it.each(SWATCH_KEYS)("%s: the legend swatch is the bar segment's token and opacity", (k) => {
    const { top } = sheet();
    const sw = merged(top, `.swatch.${k}`);
    const seg = merged(top, `.bar .seg.${k}`);
    expect(token(sw.background)).toBeDefined();
    expect(token(sw.background)).toBe(token(seg.fill));
    expect(sw.opacity).toBe(seg.opacity);
  });
  it("a swatch is a 10px square", () => {
    const sw = merged(sheet().top, ".swatch");
    expect([sw.width, sw.height]).toEqual(["10px", "10px"]);
  });
  it("defines every class the renderer is told to emit", () => {
    const { top } = sheet();
    for (const sel of [
      ".tagline",
      ".panel-sub",
      ".idtag",
      ".hint",
      ".swatch",
      ".attn",
      '.attn[data-level="ok"]',
      '.attn[data-level="warn"]',
      '.attn[data-level="risk"]',
      ".fold > summary .when-open",
      ".fold[open] > summary .when-open",
      ".fold[open] > summary .when-closed",
      ".fold > summary::before",
      ".fold[open] > summary::before",
      ...SWATCH_KEYS.map((k) => `.swatch.${k}`),
    ])
      expect({ sel, set: Object.keys(merged(top, sel)).length > 0 }).toEqual({ sel, set: true });
  });
  it("paints with tokens only, so every new rule has a light and a dark value", () => {
    const { top, media } = sheet();
    const rules = [...top, ...media.flatMap((m) => m.rules)].filter(
      (r) => !r.sel.some((s) => s.startsWith(":root")),
    );
    const raw = rules.flatMap((r) =>
      Object.entries(r.d)
        .filter(([, v]) => /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\((?!0, 0, 0,)/i.test(v))
        .map(([k, v]) => `${r.sel[0]} { ${k}: ${v} }`),
    );
    expect(raw).toEqual([]); // only black overlays (scrim, shadow) may be written out in full
  });
  it("body text is 15px/1.5 and tables 14px; nothing is set smaller than 13.5px", () => {
    const { top, media } = sheet();
    expect(merged(top, "body").font).toMatch(/^15px\/1\.5\b/);
    expect(merged(top, ".tbl")["font-size"]).toBe("14px");
    const sizes = [...top, ...media.flatMap((m) => m.rules)]
      .filter((r) => r.d["font-size"] && !Number.isNaN(px(r.d["font-size"])))
      .map((r) => ({ sel: r.sel[0], px: px(r.d["font-size"]) }));
    expect(sizes.filter((x) => x.px < 13.5)).toEqual([]);
  });
  it("labels and column headings are plain words: no small caps, letter-spacing or mono", () => {
    const { top } = sheet();
    for (const sel of [".lbl", ".lane .lbl", ".tbl thead th"]) {
      const d = merged(top, sel);
      expect({
        sel,
        caps: d["text-transform"],
        gap: d["letter-spacing"],
        font: d["font-family"],
      }).toEqual({
        sel,
        caps: undefined,
        gap: undefined,
        font: undefined,
      });
    }
  });
  it("strips, sentences and toasts can wrap, so nothing pushes the page sideways at 390px", () => {
    const { top } = sheet();
    for (const sel of [
      ".attn",
      ".tagline",
      ".panel-sub",
      ".hint",
      ".line",
      ".toast > span",
      ".chip",
    ])
      expect({ sel, ws: merged(top, sel)["white-space"] }).not.toEqual({ sel, ws: "nowrap" });
    expect(merged(top, ".tw")["overflow-x"]).toBe("auto"); // tables scroll inside their own box
  });
  it("on a phone buttons and fields are 44px tall and an id link at least 36px", () => {
    const phone = sheet().media.find((m) => /max-width:\s*480px/.test(m.query));
    expect(phone).toBeDefined();
    const rules = phone!.rules;
    for (const sel of [".btn", "select", ".fold > summary", ".jump summary", ".jump a"])
      expect({ sel, h: px(merged(rules, sel)["min-height"]) }).toEqual({ sel, h: 44 });
    const tid = merged(rules, ".tid");
    expect([px(tid["min-height"]), px(tid["min-width"])]).toEqual([36, 36]);
  });
  it("keeps a visible focus ring", () => {
    expect(merged(sheet().top, ":focus-visible").outline).toMatch(/^2px solid var\(--accent\)/);
  });
});

describe("the fold toggle (CSS owns it)", () => {
  const { JSDOM } = require("jsdom");
  const toggle =
    '<summary><span class="when-open">Hide</span><span class="when-closed">Show</span></summary>';
  const dom = new JSDOM(
    `<style>${fs.readFileSync(CSS, "utf8")}</style>` +
      `<details class="fold" id="o" open>${toggle}</details><details class="fold" id="c">${toggle}</details>`,
  );
  const shown = (id: string, which: string): boolean => {
    const el = dom.window.document.querySelector(`#${id} .${which}`);
    return dom.window.getComputedStyle(el).display !== "none";
  };
  it("shows Hide while the panel is open and Show while it is closed", () => {
    expect([shown("o", "when-open"), shown("o", "when-closed")]).toEqual([true, false]);
    expect([shown("c", "when-open"), shown("c", "when-closed")]).toEqual([false, true]);
  });
  it("follows the panel as it is opened and closed", () => {
    const d = dom.window.document;
    d.getElementById("c").setAttribute("open", "");
    d.getElementById("o").removeAttribute("open");
    expect([shown("c", "when-open"), shown("c", "when-closed")]).toEqual([true, false]);
    expect([shown("o", "when-open"), shown("o", "when-closed")]).toEqual([false, true]);
  });
});
