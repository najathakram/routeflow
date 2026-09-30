/**
 * WP6 T62 / R34: WCAG 2.1 contrast computed from the custom properties parsed out of styles.css,
 * light AND dark. Text pairs >= 4.5; pill pairs (`--x` on `--x-bg`) held to 4.5 too because pill
 * labels are small text (ux-spec §7: fix a failing pair by darkening the fg, never dropping the label).
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
