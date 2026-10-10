/**
 * #2717 M4a-1 (SA-578 test 21 + SA-580 R5): the mobile local fast path matches cached
 * ProductBarcode rows too, and `scanUnitKind` is gone (the shared resolver replaces it).
 * RED (M4a-1): findExactScanMatch only reads barcode/sku/unitSku today; scanUnitKind still exists.
 */
import * as wedge from "../lib/wedge-scan";
import { findExactScanMatch } from "../lib/wedge-scan";

const products = [
  {
    id: "p1",
    barcode: "4000000000019",
    sku: "COLA-6",
    unitSku: null,
    barcodes: [
      { code: "ROW-U1", level: "UNIT" },
      { code: "ROW-B1", level: "BOX" },
    ],
  },
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
    const rows = [
      {
        id: "p9",
        barcode: null,
        sku: null,
        unitSku: null,
        barcodes: [{ code: "0042100005264", level: "BOX" }],
      },
    ];
    expect(findExactScanMatch("042100005264", rows as any).match?.id).toBe("p9"); // UPC-A decode vs stored EAN-13
  });

  it("keeps the SINGLE-match rule: a row code on one product that equals another product's sku -> multiple, no match", () => {
    const clash = [
      {
        id: "a",
        barcode: null,
        sku: null,
        unitSku: null,
        barcodes: [{ code: "CLASH", level: "UNIT" }],
      },
      { id: "b", barcode: null, sku: "CLASH", unitSku: null, barcodes: [] },
    ];
    expect(findExactScanMatch("CLASH", clash as any)).toEqual({ match: null, multiple: true });
  });

  it("the SAME product holding one code at two levels (shared BOX+UNIT rows) is ONE match, not 'multiple'", () => {
    const shared = [
      {
        id: "a",
        barcode: null,
        sku: null,
        unitSku: null,
        barcodes: [
          { code: "SH", level: "BOX" },
          { code: "SH", level: "UNIT" },
        ],
      },
    ];
    expect(findExactScanMatch("SH", shared as any)).toEqual({ match: shared[0], multiple: false });
  });

  it("legacy behaviour is unchanged for rows without barcodes[] (undefined, [] and missing)", () => {
    expect(findExactScanMatch("4000000000026", products as any).match?.id).toBe("p3");
    expect(findExactScanMatch("CHIPS-1", products as any).match?.id).toBe("p2");
    expect(findExactScanMatch("NOPE", products as any)).toEqual({ match: null, multiple: false });
  });

  it("an archived cached row is still never a local match (unchanged)", () => {
    const arch = [
      {
        id: "z",
        isActive: false,
        barcode: null,
        sku: null,
        unitSku: null,
        barcodes: [{ code: "ROW-Z", level: "BOX" }],
      },
    ];
    expect(findExactScanMatch("ROW-Z", arch as any)).toEqual({ match: null, multiple: false });
  });
});

describe("scanUnitKind is replaced by the shared resolver (SA-580)", () => {
  it("wedge-scan no longer exports scanUnitKind", () => {
    expect((wedge as Record<string, unknown>).scanUnitKind).toBeUndefined();
  });
});

describe("levelsForScan — trusts scanMatch only for the code that produced it (Opus blocker, #2764)", () => {
  const prod = {
    barcode: "SHARED-B",
    sku: "COLA-24",
    unitSku: "UNIT-U",
    unitsPerBox: 24,
    scanMatch: { code: "SHARED-B", levels: ["UNIT", "BOX"] as Array<"BOX" | "UNIT"> },
  };
  it("a different code re-derives locally (unitSku -> UNIT)", () => {
    expect(wedge.levelsForScan("UNIT-U", prod)).toEqual(["UNIT"]);
  });
  it("the same code (any case / whitespace) keeps the server levels", () => {
    expect(wedge.levelsForScan(" shared-b ", prod)).toEqual(["UNIT", "BOX"]);
  });
  it("a UPC-A scan of the code the server resolved as EAN-13 still counts as the same code", () => {
    const p = {
      barcode: "0042100005264",
      unitsPerBox: 6,
      scanMatch: { code: "0042100005264", levels: ["BOX"] as Array<"BOX" | "UNIT"> },
    };
    expect(wedge.levelsForScan("042100005264", p)).toEqual(["BOX"]);
  });
  it("a codeless scanMatch stub (never sent by the server) is taken as-is", () => {
    expect(
      wedge.levelsForScan("UNIT-U", {
        ...prod,
        scanMatch: { levels: ["BOX"] as Array<"BOX" | "UNIT"> },
      }),
    ).toEqual(["BOX"]);
  });
});

describe("levelsForScan — the local path ignores cached rows whose level is not BOX/UNIT (#2764)", () => {
  it("CASE + UNIT rows on one code -> [UNIT]", () => {
    const p = {
      unitsPerBox: 6,
      barcodes: [
        { code: "SH", level: "CASE" },
        { code: "SH", level: "UNIT" },
      ],
    };
    expect(wedge.levelsForScan("SH", p as any)).toEqual(["UNIT"]);
  });
});
