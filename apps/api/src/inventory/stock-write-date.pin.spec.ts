import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Row 563 pin (SA-794 / SA-802): every stock write whose date a person chose goes through `stockWriteDate`, the one gate
 * that refuses a date inside a filed period. A bypass would be a raw `new Date(dto.effectiveDate)` or a direct
 * `effectiveDateOf(` call (future check only) anywhere in the api source outside `inventory/stock-write-date.ts`.
 */
const SRC = join(__dirname, "..");
const HOME = join(__dirname, "stock-write-date.ts");
const BYPASS: Array<[RegExp, string]> = [
  [
    /new\s+Date\(\s*dto\.effectiveDate\b/,
    "new Date(dto.effectiveDate): route it through stockWriteDate",
  ],
  [/\beffectiveDateOf\s*\(/, "effectiveDateOf(…): call stockWriteDate, which runs it first"],
];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return name === "node_modules" ? [] : sources(abs);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [abs] : [];
  });
}

export function bypassesIn(text: string): string[] {
  const code = stripComments(text);
  return BYPASS.filter(([re]) => re.test(code)).map(([, why]) => why);
}

describe("Row 563 pin: one date gate for person-dated stock writes", () => {
  it("the detector catches both bypass shapes and ignores comments (self-test)", () => {
    expect(
      bypassesIn("const d = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();"),
    ).toHaveLength(1);
    expect(bypassesIn("const d = effectiveDateOf(dto.effectiveDate);")).toHaveLength(1);
    expect(bypassesIn("// effectiveDateOf(dto.effectiveDate) is gone\nconst d = 1;")).toHaveLength(
      0,
    );
    expect(bypassesIn('export { effectiveDateOf } from "./stock-write-date";')).toHaveLength(0);
  });

  it("no api source outside stock-write-date.ts bypasses stockWriteDate", () => {
    const offenders = sources(SRC)
      .filter((f) => f !== HOME)
      .flatMap((f) =>
        bypassesIn(readFileSync(f, "utf8")).map((why) => `${relative(SRC, f)}: ${why}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the gate is the module's export, and the four writers call it", () => {
    const inv = readFileSync(join(__dirname, "inventory.service.ts"), "utf8");
    expect(readFileSync(HOME, "utf8")).toMatch(/export async function stockWriteDate\(/);
    // adjustment + purchase, the legacy count, the session commit
    expect(inv.match(/await stockWriteDate\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("W-755 R9: the session commit gates the date AFTER its under-lock COMMITTED re-read (a committed count is never refused)", () => {
    const inv = stripComments(readFileSync(join(__dirname, "inventory.service.ts"), "utf8"));
    const start = inv.indexOf("private async commitStockCountBatches(");
    expect(start).toBeGreaterThan(-1);
    const body = inv.slice(start);
    const reread = body.search(/\.stockCountSession\.findUnique\(/);
    const committed = body.search(/fresh\.status\s*===\s*"COMMITTED"/);
    const gate = body.search(/await\s+stockWriteDate\(/);
    expect(reread).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(reread);
    expect(gate).toBeGreaterThan(committed);
  });
});
