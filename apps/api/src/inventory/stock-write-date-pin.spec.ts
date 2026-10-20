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

const RAW_DTO_DATE = /new\s+Date\s*\(\s*dto\s*\.\s*effectiveDate\b/;
const EFFECTIVE_DATE_OF_CALL = /\beffectiveDateOf\s*\(/;

/** The offences in one file's text; the gate file itself is the only legitimate `effectiveDateOf(`. */
export function findOffences(source: string, isGateFile: boolean): string[] {
  const out: string[] = [];
  if (RAW_DTO_DATE.test(source)) out.push("new Date(dto.effectiveDate)");
  if (!isGateFile && EFFECTIVE_DATE_OF_CALL.test(source)) out.push("effectiveDateOf(");
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
      "new Date(dto.effectiveDate)",
    ]);
    expect(
      findOffences("const d = dto.effectiveDate ? new Date(\n  dto.effectiveDate) : x", false),
    ).toEqual(["new Date(dto.effectiveDate)"]);
    expect(findOffences("const d = effectiveDateOf(dto.effectiveDate);", false)).toEqual([
      "effectiveDateOf(",
    ]);
    expect(findOffences("const d = effectiveDateOf(raw, now);", true)).toEqual([]);
    expect(
      findOffences(
        "const d = await stockWriteDate(db, { tenantId, productIds, raw: dto.effectiveDate });",
        false,
      ),
    ).toEqual([]);
  });
});
