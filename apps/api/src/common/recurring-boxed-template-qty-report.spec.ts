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
  productPrice: 40, // the product's per-box price
  ...over,
});

describe("B646 pre-landing report: classifyTemplateLine", () => {
  it("a box-intent line (6 boxes of 12 at the box price): not flagged, recorded 6 -> 72, no over-bill", () => {
    const [c] = run("classify", [line()]);
    expect(c).toMatchObject({
      priceBasis: "box",
      flagged: false,
      currentUnitsRecorded: 6,
      postFixUnitsRecorded: 72,
      unitsRecordedDeltaPerCycle: 66,
      billedPerCycle: 240,
      possibleOverbillPerCycle: 0,
    });
  });

  it("BOX-priced but qty looks like pieces (72 of a 12-pack at $40): possible over-bill $2,640 per cycle", () => {
    const [c] = run("classify", [line({ qty: 72 })]);
    expect(c).toMatchObject({
      priceBasis: "box",
      flagged: true,
      reasons: ["qty>unitsPerBox"],
      billedPerCycle: 2880,
      billedIfPiecesIntent: 240,
      possibleOverbillPerCycle: 2640,
      currentUnitsRecorded: 72,
      postFixUnitsRecorded: 864,
    });
  });

  // Opus B646 review MED: a PIECES-priced template (qty 10 of a 12-pack at $3.33 per piece) billed and
  // recorded correctly until now; after the fix it records 120 units. It must be FLAGGED even though
  // qty <= unitsPerBox, and it was never over-billed.
  it("PIECES-priced, qty <= pack (10 at $3.33 of a $40 12-pack): flagged, recorded 10 -> 120, no over-bill", () => {
    const [c] = run("classify", [line({ qty: 10, unitPrice: 3.33 })]);
    expect(c).toMatchObject({
      priceBasis: "pieces",
      flagged: true,
      reasons: ["pieces-priced"],
      currentUnitsRecorded: 10,
      postFixUnitsRecorded: 120,
      possibleOverbillPerCycle: 0,
    });
  });

  it("PIECES-priced with qty > pack (72 at $3.33): flagged, and NO phantom over-bill is reported", () => {
    const [c] = run("classify", [line({ qty: 72, unitPrice: 3.33 })]);
    expect(c).toMatchObject({ priceBasis: "pieces", flagged: true, possibleOverbillPerCycle: 0 });
    expect(c.reasons).toEqual(["qty>unitsPerBox", "pieces-priced"]);
  });

  it("a price between the piece and box price, or no product price, is flagged as unclear", () => {
    const [a, b] = run("classify", [line({ unitPrice: 12 }), line({ productPrice: null })]);
    expect(a).toMatchObject({ priceBasis: "unclear", flagged: true });
    expect(b).toMatchObject({ priceBasis: "unclear", flagged: true, possibleOverbillPerCycle: 0 });
  });

  // Opus B646 review (a642f2c7) MED: for a 2-pack the per-piece price is exactly half the box price, so
  // testing "box" first (ratio >= 0.5) read a per-piece 2-pack line as box-priced and left it unflagged.
  it("a PIECES-priced 2-pack ($20 of a $40 2-pack) is pieces and flagged; a box-priced 3-pack is box; $0 unclear", () => {
    const [two, three, zero] = run("classify", [
      line({ qty: 2, unitPrice: 20, productPrice: 40, unitsPerBox: 2 }),
      line({ qty: 2, unitPrice: 40, productPrice: 40, unitsPerBox: 3 }),
      line({ unitPrice: 0 }),
    ]);
    expect(two).toMatchObject({ priceBasis: "pieces", flagged: true, postFixUnitsRecorded: 4 });
    expect(three).toMatchObject({ priceBasis: "box", flagged: false });
    expect(zero).toMatchObject({ priceBasis: "unclear", flagged: true });
  });

  it("a non-integer qty is flagged; 2.5 splits (30 units), 1.3 does not (stays 1.3)", () => {
    const [a, b] = run("classify", [line({ qty: 2.5 }), line({ qty: 1.3 })]);
    expect(a).toMatchObject({ flagged: true, reasons: ["non-integer"], splits: true });
    expect(a.postFixUnitsRecorded).toBe(30);
    expect(b).toMatchObject({ flagged: true, splits: false, postFixUnitsRecorded: 1.3 });
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
      {
        tenantId: "t-1",
        flagged: false,
        unitsRecordedDeltaPerCycle: 66,
        possibleOverbillPerCycle: 0,
      },
      {
        tenantId: "t-1",
        flagged: true,
        unitsRecordedDeltaPerCycle: 792,
        possibleOverbillPerCycle: 2640,
      },
      {
        tenantId: "t-2",
        flagged: false,
        unitsRecordedDeltaPerCycle: 11,
        possibleOverbillPerCycle: 0,
      },
    ];
    const [t1, t2] = run("summarize", rows);
    expect(t1).toMatchObject({
      tenantId: "t-1",
      lines: 2,
      flagged: 1,
      unitsRecordedDeltaPerCycle: 858,
    });
    expect(t1.possibleOverbillPerCycle).toBe(2640);
    expect(t1.rows[0].flagged).toBe(true);
    expect(t2).toMatchObject({ tenantId: "t-2", lines: 1, flagged: 0 });
  });

  it("the report groups by the TEMPLATE's tenant (an item's own tenantId is nullable)", () => {
    const src = fs.readFileSync(REPORT, "utf8");
    expect(src).toMatch(/recurringInvoice: \{ select: \{ tenantId: true, isActive: true \} \}/);
    expect(src).toMatch(/tenantId: it\.recurringInvoice\?\.tenantId/);
  });

  it("the report scans PAUSED templates too (a reactivated one skips the gate) and marks them", () => {
    const src = fs.readFileSync(REPORT, "utf8");
    expect(src).not.toMatch(/recurringInvoice: \{ isActive: true/);
    expect(src).toMatch(/templateActive: it\.recurringInvoice\?\.isActive !== false/);
    expect(src).toMatch(/PAUSED/);
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
