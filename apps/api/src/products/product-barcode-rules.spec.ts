import {
  barcodeRowsToView,
  mirrorableImageKeys,
  parseFocalFromKey,
  planBarcodeRows,
  printableUnitBarcode,
  synthesizeLegacyBarcodes,
  synthesizeLegacyImages,
} from "./product-barcode-rules";

const PID = "11111111-1111-4111-8111-111111111111";
const own = (n: number) => `products/${PID}/img-${n}.jpg`;
const OTHER = "22222222-2222-4222-8222-222222222222";
const foreign = (n: number) => `products/${OTHER}/img-${n}.jpg`;

// #2728 M1 follow-up (SA-572f): the mirror set for ProductImage rows — own signable keys, deduped.
describe("mirrorableImageKeys (#2728 M1 follow-up, SA-572f)", () => {
  it("dedupes a repeated own key, first occurrence keeps its position", () => {
    expect(mirrorableImageKeys(PID, [own(1), own(1), own(2)])).toEqual([own(1), own(2)]);
  });

  it("drops a foreign (not-this-product) key entirely", () => {
    expect(mirrorableImageKeys(PID, [own(1), foreign(1), own(2)])).toEqual([own(1), own(2)]);
  });

  it("null/undefined imageKeys -> empty", () => {
    expect(mirrorableImageKeys(PID, null)).toEqual([]);
    expect(mirrorableImageKeys(PID, undefined)).toEqual([]);
  });
});

// T4 (R4, #2717 M1, SA-572a): the owner's rule — one legacy barcode becomes the product's
// level rows; unitsPerBox > 1 gets a BOX row plus a COPIED UNIT row sharing the code.
describe("planBarcodeRows (#2717 M1, SA-572a)", () => {
  it("unitsPerBox > 1 plans a BOX ENTERED row followed by a UNIT COPIED row, same code", () => {
    const rows = planBarcodeRows({ barcode: "036000291452", unitsPerBox: 12 });
    expect(rows).toEqual([
      {
        code: "036000291452",
        level: "BOX",
        symbology: "UPC_A",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: "BOX",
      },
      {
        code: "036000291452",
        level: "UNIT",
        symbology: "UPC_A",
        origin: "COPIED",
        copiedFromLevel: "BOX",
        primaryFor: "UNIT",
      },
    ]);
  });

  it("unitsPerBox 1 plans a single UNIT ENTERED row", () => {
    expect(planBarcodeRows({ barcode: "036000291452", unitsPerBox: 1 })).toEqual([
      {
        code: "036000291452",
        level: "UNIT",
        symbology: "UPC_A",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: "UNIT",
      },
    ]);
  });

  it("unitsPerBox null plans the same single UNIT row as 1", () => {
    expect(planBarcodeRows({ barcode: "036000291452", unitsPerBox: null })).toEqual(
      planBarcodeRows({ barcode: "036000291452", unitsPerBox: 1 }),
    );
  });

  it("unitsPerBox 0 plans the same single UNIT row as 1", () => {
    expect(planBarcodeRows({ barcode: "036000291452", unitsPerBox: 0 })).toEqual(
      planBarcodeRows({ barcode: "036000291452", unitsPerBox: 1 }),
    );
  });

  it("no code plans no rows", () => {
    expect(planBarcodeRows({ barcode: null, unitsPerBox: 12 })).toEqual([]);
    expect(planBarcodeRows({ barcode: "", unitsPerBox: 12 })).toEqual([]);
    expect(planBarcodeRows({ barcode: "   ", unitsPerBox: 12 })).toEqual([]);
  });
});

// T5 (R5, SA-572a ii): the unit barcode prints iff a UNIT row that is the UNIT primary exists.
describe("printableUnitBarcode (#2717 M1, SA-572a)", () => {
  it("returns the code when a COPIED UNIT row is the UNIT primary", () => {
    const rows = planBarcodeRows({ barcode: "036000291452", unitsPerBox: 12 });
    expect(printableUnitBarcode(rows)).toBe("036000291452");
  });

  it("returns null when only a BOX primary row exists", () => {
    const rows = [
      { code: "X", level: "BOX", primaryFor: "BOX" },
      { code: "X", level: "UNIT", primaryFor: null },
    ];
    expect(printableUnitBarcode(rows)).toBeNull();
  });

  it("returns null when the UNIT row is not a primary", () => {
    const rows = [{ code: "X", level: "UNIT", primaryFor: null }];
    expect(printableUnitBarcode(rows)).toBeNull();
  });
});

// T6 (R6, #2717 M1): the inverse of products.service.ts's encodeFocalSuffix.
describe("parseFocalFromKey (#2717 M1)", () => {
  it("parses a focal suffix on the basename", () => {
    expect(parseFocalFromKey("products/p/k-fp30x70.jpg")).toEqual({ x: 30, y: 70 });
  });

  it("returns null with no suffix", () => {
    expect(parseFocalFromKey("products/p/k.jpg")).toBeNull();
  });

  it("clamps an out-of-range value to 100", () => {
    expect(parseFocalFromKey("products/p/k-fp150x7.jpg")).toEqual({ x: 100, y: 7 });
  });

  it("returns null for a non-numeric suffix", () => {
    expect(parseFocalFromKey("products/p/k-fpAxB.jpg")).toBeNull();
  });

  it("round-trips with a key built as encodeFocalSuffix would build it", () => {
    expect(parseFocalFromKey("products/p/k-fp30x70.jpg")).toEqual({ x: 30, y: 70 });
  });

  it("ignores a suffix-shaped substring that sits in a directory name, not the basename", () => {
    expect(parseFocalFromKey("products/p-fp10x10/k.jpg")).toBeNull();
  });
});

// SA-572b Q5: the read-model fallback for a product with no ProductBarcode rows yet.
describe("synthesizeLegacyBarcodes (#2717 M1, SA-572b Q5)", () => {
  it("flags every synthesized row's origin LEGACY, fields equal to planBarcodeRows", () => {
    const planned = planBarcodeRows({ barcode: "036000291452", unitsPerBox: 12 });
    const legacy = synthesizeLegacyBarcodes({ barcode: "036000291452", unitsPerBox: 12 });
    expect(legacy).toHaveLength(planned.length);
    legacy.forEach((row, i) => {
      expect(row.origin).toBe("LEGACY");
      expect(row.code).toBe(planned[i].code);
      expect(row.level).toBe(planned[i].level);
      expect(row.symbology).toBe(planned[i].symbology);
      expect(row.copiedFromLevel).toBe(planned[i].copiedFromLevel);
      expect(row.primaryFor).toBe(planned[i].primaryFor);
    });
  });
});

describe("barcodeRowsToView (#2717 M1)", () => {
  it("maps planned rows to the view shape, origin carried through", () => {
    const rows = planBarcodeRows({ barcode: "036000291452", unitsPerBox: 12 });
    expect(barcodeRowsToView(rows)).toEqual(rows);
  });
});

// SA-572b Q5: images synthesized from the legacy imageKeys array.
describe("synthesizeLegacyImages (#2717 M1, SA-572b Q5)", () => {
  it("builds a view per key, sortOrder = index, isPrimary only at index 0, focal parsed, origin LEGACY", () => {
    const views = synthesizeLegacyImages(["a.jpg", "b-fp10x20.png"], (k) => "u:" + k);
    expect(views).toHaveLength(2);
    expect(views[0]).toEqual({
      storageKey: "a.jpg",
      url: "u:a.jpg",
      focalX: null,
      focalY: null,
      sortOrder: 0,
      isPrimary: true,
      altText: null,
      origin: "LEGACY",
    });
    expect(views[1]).toEqual({
      storageKey: "b-fp10x20.png",
      url: "u:b-fp10x20.png",
      focalX: 10,
      focalY: 20,
      sortOrder: 1,
      isPrimary: false,
      altText: null,
      origin: "LEGACY",
    });
  });
});
