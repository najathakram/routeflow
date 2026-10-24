import { readFileSync } from "fs";
import { join } from "path";
import { liveBarcodeRows } from "./product-barcode-rules";

/**
 * SA-603a: `ProductBarcode.code` is NULL once a deactivated product's code is released (retiredCode
 * keeps it). Every reader of the rows must treat a NULL code as released, i.e. skip the row.
 */
describe("liveBarcodeRows (a released level code is not a live code)", () => {
  it("drops rows whose code is NULL and keeps the others, typed as non-null", () => {
    const rows = [
      { code: "012345678905", level: "UNIT" },
      { code: null, level: "CASE" },
      { code: "112345678902", level: "CASE" },
    ];
    const live = liveBarcodeRows(rows);
    expect(live.map((r) => r.code)).toEqual(["012345678905", "112345678902"]);
    const first: string = live[0].code; // compiles only if the code is typed non-null
    expect(first).toBe("012345678905");
  });

  it("is safe on a missing list and on all-released rows", () => {
    expect(liveBarcodeRows(undefined)).toEqual([]);
    expect(liveBarcodeRows(null)).toEqual([]);
    expect(liveBarcodeRows([{ code: null, level: "UNIT" }])).toEqual([]);
  });

  it("both readers of ProductBarcode.code go through it (source pin)", () => {
    const root = join(__dirname, "..", "..");
    const service = readFileSync(join(__dirname, "products.service.ts"), "utf8");
    const report = readFileSync(
      join(root, "prisma", "report-product-barcode-conflicts.ts"),
      "utf8",
    );
    expect(service).toMatch(/liveBarcodeRows\(/);
    expect(report).toMatch(/liveBarcodeRows\(/);
  });
});
