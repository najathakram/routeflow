/**
 * #2717 M4a-1 (SA-578 test 21 + SA-580 R5): the mobile local fast path matches cached
 * ProductBarcode rows too, and `scanUnitKind` is gone (the shared resolver replaces it).
 * RED (M4a-1): findExactScanMatch only reads barcode/sku/unitSku today; scanUnitKind still exists.
 */
import * as wedge from "../lib/wedge-scan";
import { findExactScanMatch } from "../lib/wedge-scan";

const products = [
  { id: "p1", barcode: "4000000000019", sku: "COLA-6", unitSku: null, barcodes: [{ code: "ROW-U1", level: "UNIT" }, { code: "ROW-B1", level: "BOX" }] },
  { id: "p2", barcode: null, sku: "CHIPS-12", unitSku: "CHIPS-1", barcodes: [] },
  { id: "p3", barcode: "4000000000026", sku: null, unitSku: null, barcodes: undefined },
];

describe("findExactScanMatch — cached barcodes[] (M1 list rows)", () => {
  it("matches a ProductBarcode row code that is NOT in barcode/sku/unitSku", () => {
    expect(findExactScanMatch("ROW-U1", products as any).match?.id).toBe("p1");
    expect(findExactScanMatch("ROW-B1", products as any).match?.id).toBe("p1");
  });

  it("matches row codes case-insensitively and through the normalizeScanCode candidate set", () => {
    expect(findExactScanMatch("row-u1", products as any).match?.id).toBe("p1");
    const rows = [{ id: "p9", barcode: null, sku: null, unitSku: null, barcodes: [{ code: "0042100005264", level: "BOX" }] }];
    expect(findExactScanMatch("042100005264", rows as any).match?.id).toBe("p9"); // UPC-A decode vs stored EAN-13
  });

  it("keeps the SINGLE-match rule: a row code on one product that equals another product's sku -> multiple, no match", () => {
    const clash = [
      { id: "a", barcode: null, sku: null, unitSku: null, barcodes: [{ code: "CLASH", level: "UNIT" }] },
      { id: "b", barcode: null, sku: "CLASH", unitSku: null, barcodes: [] },
    ];
    expect(findExactScanMatch("CLASH", clash as any)).toEqual({ match: null, multiple: true });
  });

  it("the SAME product holding one code at two levels (shared BOX+UNIT rows) is ONE match, not 'multiple'", () => {
    const shared = [{ id: "a", barcode: null, sku: null, unitSku: null, barcodes: [{ code: "SH", level: "BOX" }, { code: "SH", level: "UNIT" }] }];
    expect(findExactScanMatch("SH", shared as any)).toEqual({ match: shared[0], multiple: false });
  });

  it("legacy behaviour is unchanged for rows without barcodes[] (undefined, [] and missing)", () => {
    expect(findExactScanMatch("4000000000026", products as any).match?.id).toBe("p3");
    expect(findExactScanMatch("CHIPS-1", products as any).match?.id).toBe("p2");
    expect(findExactScanMatch("NOPE", products as any)).toEqual({ match: null, multiple: false });
  });

  it("an archived cached row is still never a local match (unchanged)", () => {
    const arch = [{ id: "z", isActive: false, barcode: null, sku: null, unitSku: null, barcodes: [{ code: "ROW-Z", level: "BOX" }] }];
    expect(findExactScanMatch("ROW-Z", arch as any)).toEqual({ match: null, multiple: false });
  });
});

describe("scanUnitKind is replaced by the shared resolver (SA-580)", () => {
  it("wedge-scan no longer exports scanUnitKind", () => {
    expect((wedge as Record<string, unknown>).scanUnitKind).toBeUndefined();
  });
});
