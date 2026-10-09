import * as fs from "fs";
import * as path from "path";

/**
 * SA-733 D9 pin: every Stripe amount in billing goes through `toCents` / `fromCents` from
 * `@routeflow/pricing`. A hand-written `* 100` (or a local copy of the helper) is how a cent drifts:
 * `Math.round(1.005 * 100)` is 100 while the shared helper gives 101. Source scan, comments skipped.
 */
const DIR = __dirname;
const sources = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
  .map((f) => ({ f, text: fs.readFileSync(path.join(DIR, f), "utf8") }));
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""));

describe("billing money: no bare cents arithmetic (SA-733 D9)", () => {
  it("there are billing sources to scan", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("no `* 100` / `/ 100` in a non-spec billing source", () => {
    const hits: string[] = [];
    for (const { f, text } of sources)
      code(text).forEach((line, i) => {
        if (/[*/]\s*100(?![\d.])/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    expect(hits).toEqual([]);
  });

  it("toCents / fromCents are defined nowhere in billing (they come from @routeflow/pricing)", () => {
    const hits = sources
      .filter(({ text }) => /(function|const)\s+(toCents|fromCents)\b/.test(code(text).join("\n")))
      .map(({ f }) => f);
    expect(hits).toEqual([]);
  });
});
