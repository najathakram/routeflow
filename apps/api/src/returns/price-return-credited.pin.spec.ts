import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-840 A-2 (F1) pin, class not instance: `priceReturn` takes the credits the lines already carry as a REQUIRED argument, so a
 * fifth caller cannot silently price against an uncredited line again. The one caller that may price with no credits is
 * `findAll` (a whole list page, no per-row query), and it says so by name: `NO_CREDITS` is declared once and used once.
 */
const DIR = __dirname;
const SERVICE = readFileSync(join(DIR, "returns.service.ts"), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The comma-separated top-level arguments of the call that opens at `open` (the index of its "("). */
function argsOf(src: string, open: number): string[] {
  let depth = 0;
  let cur = "";
  const out: string[] = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        return out;
      }
    } else if (ch === "," && depth === 1) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return out;
}

describe("SA-840 A-2 pin: priceReturn reads credits it is GIVEN", () => {
  const src = code(SERVICE);

  it("the credited parameter is required (no `?`, no default)", () => {
    const sig = src.match(/private priceReturn\(([\s\S]*?)\n  \): \{/);
    expect(sig).not.toBeNull();
    expect(sig![1]).toMatch(/\n\s+credited: ReadonlyMap<string, LineCredit>,/);
    expect(sig![1]).not.toMatch(/credited\?/);
    expect(sig![1]).not.toMatch(/credited[^,\n]*=/);
  });

  it("all four callers pass a fourth argument", () => {
    const calls = [...src.matchAll(/this\.priceReturn\(/g)];
    expect(calls).toHaveLength(4);
    for (const m of calls) expect(argsOf(src, m.index! + m[0].length - 1).length).toBe(4);
  });

  it("no caller prices on an inline empty Map: the credits are read (creditsForPricing) or NO_CREDITS is named", () => {
    const body = src.slice(
      src.indexOf("private priceReturn("),
      src.indexOf("async processRefund("),
    );
    expect(body).toMatch(/\n\s+credited,\n/); // the slice is priced on the argument it was given
    expect(body).not.toMatch(/credited:\s*new Map\(\)/);
    for (const m of src.matchAll(/this\.priceReturn\(/g))
      expect(argsOf(src, m.index! + m[0].length - 1)[3]).not.toMatch(/new Map\(/);
  });

  it("NO_CREDITS is declared once and used once, and the use is findAll's", () => {
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(f),
    );
    const hits = files.flatMap((f) =>
      [...code(readFileSync(join(DIR, f), "utf8")).matchAll(/\bNO_CREDITS\b/g)].map(() => f),
    );
    expect(hits).toEqual(["returns.service.ts", "returns.service.ts"]); // the declaration, then the one use
    expect(src.match(/const NO_CREDITS\b/g)).toHaveLength(1);
    const findAll = src.slice(src.indexOf("async findAll("), src.indexOf("async approve("));
    expect(findAll).toMatch(/\bNO_CREDITS\b/);
  });

  it("billedBasisFor, externalRefundBasis and findOne read the credits through the one reader", () => {
    expect(src.match(/this\.creditsForPricing\(/g)).toHaveLength(3);
  });

  it("only findOne names a return to leave out (excludeReturnId): exactly 1 of the 3 reader calls has a third argument", () => {
    const calls = [...src.matchAll(/this\.creditsForPricing\(/g)].map((m) => ({
      at: m.index!,
      args: argsOf(src, m.index! + m[0].length - 1),
    }));
    expect(calls).toHaveLength(3);
    const withThird = calls.filter((c) => c.args.length === 3);
    expect(withThird).toHaveLength(1);
    expect(calls.filter((c) => c.args.length === 2)).toHaveLength(2);
    const findOne = src.slice(src.indexOf("async findOne("));
    expect(withThird[0].at).toBeGreaterThan(src.indexOf("async findOne("));
    expect(findOne).toContain("this.creditsForPricing(");
    expect(withThird[0].args[2]).toMatch(/returnId:\s*ret\.id/);
  });
});
