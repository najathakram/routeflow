/**
 * W-858 (SA-940 PR-1) — the order builder and the till total a sale through ONE line mapping.
 *
 * `saleTotals` (@routeflow/pricing) takes a category block per line; building it by hand in each screen is how the
 * builder and the counter could drift (levy name, `priceIncludesTax` default, the Number() of a Decimal rate). Every
 * `saleTotals(` call in the web app must be fed by `saleLinesOf(...)` from `lib/sale-lines.ts`: no second copy.
 *
 * Excluded: spec/test files and node_modules/.next.
 */
import * as fs from "fs";
import * as path from "path";

const WEB_ROOT = path.resolve(__dirname, "..");

/** The text inside the balanced parens of each `saleTotals(` call (spaced, namespaced or aliased). */
function saleTotalsCalls(src: string): string[] {
  const names = ["saleTotals", ...[...src.matchAll(/saleTotals\s+as\s+(\w+)/g)].map((m) => m[1])];
  const out: string[] = [];
  for (const name of names) {
    const open = new RegExp(`\\b${name}\\s*(?:\\?\\.\\s*)?\\(`, "g");
    for (let m = open.exec(src); m; m = open.exec(src)) {
      let depth = 1;
      let i = open.lastIndex;
      for (; i < src.length && depth > 0; i++)
        depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
      out.push(src.slice(open.lastIndex, i - 1));
    }
  }
  return out;
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");

/** True when some saleTotals call is not fed by saleLinesOf. */
function hasHandMappedSaleTotals(src: string): boolean {
  return saleTotalsCalls(strip(src)).some((b) => !/\bsaleLinesOf\s*\(/.test(b));
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "coverage", ".expo", "e2e"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.[tj]sx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

describe("every saleTotals call in the web app maps its lines through saleLinesOf (W-858)", () => {
  it.each([
    [
      "an inline lines.map",
      "saleTotals(lines.map((l) => ({ unitPrice: l.unitPrice })), { taxRate })",
    ],
    ["a bare variable", "saleTotals(rows, { taxRate })"],
    ["a multi-line call", "saleTotals(\n  items.map((i) => i),\n  { taxRate },\n)"],
    ["a namespace call", "pricing.saleTotals(rows, {})"],
    ["an aliased import", "import { saleTotals as st } from 'x';\nst(rows, {});"],
  ])("the detector sees %s", (_name, src) => {
    expect(hasHandMappedSaleTotals(src)).toBe(true);
  });

  it.each([
    ["the shared mapper", "saleTotals(saleLinesOf(lines, categories), { taxRate })"],
    ["a mention in a comment", "// saleTotals(lines.map(x))\nconst a = 1;"],
    ["no call at all", "const saleTotalsLabel = 'x';"],
  ])("the detector leaves %s alone", (_name, src) => {
    expect(hasHandMappedSaleTotals(src)).toBe(false);
  });

  it("no web source hand-maps lines into saleTotals", () => {
    const offenders = collect(WEB_ROOT)
      .filter((f) => hasHandMappedSaleTotals(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(WEB_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
