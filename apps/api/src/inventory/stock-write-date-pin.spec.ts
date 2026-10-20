/**
 * SA-802 — static pin: every client-dated stock write takes its date from `stockWriteDate`
 * (`inventory/stock-write-date.ts`). A raw `new Date(dto.effectiveDate)` skips the future bound and
 * the filed-period refusal; a direct `effectiveDateOf(` call skips the filed-period refusal.
 *
 * Walks every non-spec `.ts` under `apps/api/src`, so a NEW writer that re-opens the gap fails here.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const GATE_FILE = path.join(SRC_ROOT, "inventory", "stock-write-date.ts");

// Any `new Date(x.effectiveDate` / `Date.parse(effectiveDate` shape. `effectiveDate(` as a CALL (a
// local helper function) is not a date parse and is not matched.
const RAW_DATE_PARSE = /(?:new\s+Date|Date\s*\.\s*parse)\s*\(\s*[\w.?!]*\beffectiveDate\b(?!\s*\()/;
const EFFECTIVE_DATE_OF_CALL = /\beffectiveDateOf\s*\(/;
const EFFECTIVE_DATE_OF_IMPORT = /\bimport\b[^;]*\beffectiveDateOf\b/;
const EFFECTIVE_DATE_OF_REEXPORT = /\bexport\b[^;]*\beffectiveDateOf\b/;

/** The offences in one file's text; the gate file itself is the only legitimate `effectiveDateOf(`. */
export function findOffences(source: string, isGateFile: boolean): string[] {
  const out: string[] = [];
  if (!isGateFile && RAW_DATE_PARSE.test(source)) out.push("new Date(...effectiveDate)");
  if (!isGateFile && EFFECTIVE_DATE_OF_CALL.test(source)) out.push("effectiveDateOf(");
  if (!isGateFile && EFFECTIVE_DATE_OF_IMPORT.test(source)) out.push("import effectiveDateOf");
  if (!isGateFile && EFFECTIVE_DATE_OF_REEXPORT.test(source)) out.push("export effectiveDateOf");
  return out;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("SA-802: client-dated stock writes go through stockWriteDate", () => {
  it("no source file builds a date from dto.effectiveDate or calls effectiveDateOf directly", () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((file) =>
      findOffences(fs.readFileSync(file, "utf8"), file === GATE_FILE).map(
        (what) => `${path.relative(SRC_ROOT, file)}: ${what}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("detector self-test: flags the raw patterns, passes clean code", () => {
    expect(findOffences("const d = new Date(dto.effectiveDate);", false)).toEqual([
      "new Date(...effectiveDate)",
    ]);
    expect(
      findOffences("const d = dto.effectiveDate ? new Date(\n  dto.effectiveDate) : x", false),
    ).toEqual(["new Date(...effectiveDate)"]);
    expect(findOffences("const d = effectiveDateOf(dto.effectiveDate);", false)).toEqual([
      "effectiveDateOf(",
    ]);
    // The widened shapes: any receiver, a bare name, Date.parse, optional chaining.
    for (const code of [
      "const d = new Date(input.effectiveDate);",
      "const d = new Date(effectiveDate);",
      "const t = Date.parse(body.effectiveDate);",
      "const d = new Date(dto?.effectiveDate ?? x);",
    ]) {
      expect(findOffences(code, false)).toEqual(["new Date(...effectiveDate)"]);
    }
    expect(findOffences('import { effectiveDateOf } from "./stock-write-date";', false)).toEqual([
      "import effectiveDateOf",
    ]);
    expect(findOffences('export { effectiveDateOf } from "./stock-write-date";', false)).toEqual([
      "export effectiveDateOf",
    ]);
    // A local helper CALLED effectiveDate(...) is not a date parse.
    expect(findOffences("a.sort((x, y) => effectiveDate(y).getTime());", false)).toEqual([]);
    expect(findOffences("const d = new Date(effectiveDate(p));", false)).toEqual([]);
    expect(findOffences("const d = effectiveDateOf(raw, now);", true)).toEqual([]);
    expect(
      findOffences(
        "const d = await stockWriteDate(db, { tenantId, productIds, raw: dto.effectiveDate });",
        false,
      ),
    ).toEqual([]);
  });
});
