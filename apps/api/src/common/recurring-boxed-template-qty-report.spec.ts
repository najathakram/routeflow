import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * B646 / SA-135a — the pre-landing report's pure classifier
 * (`apps/api/scripts/lib/recurring-boxed-template-qty.mjs`), driven through a node ESM shim like
 * backfill-check-dates-script.spec.ts. The report itself is read-only: pinned below by source.
 */
const API_DIR = path.resolve(__dirname, "../..");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/recurring-boxed-template-qty.mjs"),
).href;
const REPORT = path.resolve(API_DIR, "scripts/report-recurring-boxed-template-qty.mjs");

function run(kind: "classify" | "summarize", input: unknown): any {
  const shim = `
import * as lib from "${LIB_HREF}";
const input = JSON.parse(process.env.RBT_INPUT);
const out = process.env.RBT_KIND === "classify"
  ? input.map((l) => lib.classifyTemplateLine(l))
  : lib.summarizeByTenant(input);
console.log(JSON.stringify(out));
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", shim], {
    encoding: "utf8",
    cwd: API_DIR,
    env: { ...process.env, RBT_KIND: kind, RBT_INPUT: JSON.stringify(input) },
  });
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

const line = (over: Record<string, unknown> = {}) => ({
  productId: "p-12",
  qty: 6,
  unitPrice: 40,
  unitLabel: null,
  unitsPerBox: 12,
  ...over,
});

describe("B646 pre-landing report: classifyTemplateLine", () => {
  it("a box-intent line (6 boxes of 12): not flagged, stock 6 -> 72 pieces per cycle, no over-bill", () => {
    const [c] = run("classify", [line()]);
    expect(c).toMatchObject({
      flagged: false,
      currentDecrementPieces: 6,
      postFixDecrementPieces: 72,
      stockDeltaPerCycle: 66,
      billedPerCycle: 240,
      possibleOverbillPerCycle: 0,
    });
  });

  it("a PIECES-intent line (72 of a 12-pack at $40/box): flagged; billed $2,880 vs $240; stock 72 -> 864", () => {
    const [c] = run("classify", [line({ qty: 72 })]);
    expect(c).toMatchObject({
      flagged: true,
      reasons: ["qty>unitsPerBox"],
      billedPerCycle: 2880,
      billedIfPiecesIntent: 240,
      possibleOverbillPerCycle: 2640,
      currentDecrementPieces: 72,
      postFixDecrementPieces: 864,
    });
  });

  it("a non-integer qty is flagged; 2.5 splits (30 pieces), 1.3 does not (stays 1.3)", () => {
    const [a, b] = run("classify", [line({ qty: 2.5 }), line({ qty: 1.3 })]);
    expect(a).toMatchObject({ flagged: true, reasons: ["non-integer"], splits: true });
    expect(a.postFixDecrementPieces).toBe(30);
    expect(b).toMatchObject({ flagged: true, splits: false, postFixDecrementPieces: 1.3 });
  });

  it("lines the fix does not touch return null (non-boxed, freeform, selling-unit, empty)", () => {
    expect(
      run("classify", [
        line({ unitsPerBox: 1 }),
        line({ unitsPerBox: null }),
        line({ productId: null }),
        line({ unitLabel: "Case" }),
        line({ qty: 0 }),
      ]),
    ).toEqual([null, null, null, null, null]);
  });

  it("summarizes per tenant ID only, flagged rows first", () => {
    const rows = [
      { tenantId: "t-1", flagged: false, stockDeltaPerCycle: 66, possibleOverbillPerCycle: 0 },
      { tenantId: "t-1", flagged: true, stockDeltaPerCycle: 792, possibleOverbillPerCycle: 2640 },
      { tenantId: "t-2", flagged: false, stockDeltaPerCycle: 11, possibleOverbillPerCycle: 0 },
    ];
    const [t1, t2] = run("summarize", rows);
    expect(t1).toMatchObject({ tenantId: "t-1", lines: 2, flagged: 1, stockDeltaPerCycle: 858 });
    expect(t1.possibleOverbillPerCycle).toBe(2640);
    expect(t1.rows[0].flagged).toBe(true);
    expect(t2).toMatchObject({ tenantId: "t-2", lines: 1, flagged: 0 });
  });

  it("the report is READ-ONLY and prints ids, never a name, slug, SKU or description", () => {
    // Comments stripped: the header SAYS there is no --execute flag.
    const src = fs
      .readFileSync(REPORT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/\$executeRaw|\$queryRawUnsafe|--execute/);
    expect(src).not.toMatch(/\b(name|sku|slug|description|businessName): true/);
  });
});
