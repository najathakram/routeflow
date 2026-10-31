import { invoiceBarcodeSource } from "./invoice-item-code";

/**
 * SA-1031 r2 (MP-U): a mixed-pack line prints ONE barcode source, the box (the line) or the pieces, never both.
 * One row per case of `invoiceBarcodeSource`, first hit wins.
 */
const piece = (unitBarcode: string | null) => ({ unitBarcode });

describe("invoiceBarcodeSource: the box or the pieces, never both (SA-1031 r2)", () => {
  it("1. showBarcodes false: none, whatever the line carries", () => {
    expect(invoiceBarcodeSource({ unitSku: "U" }, [piece("1")], false)).toBe("none");
    expect(invoiceBarcodeSource({ unitSku: "U" }, [], false)).toBe("none");
    expect(invoiceBarcodeSource({ sku: "S" }, undefined, false)).toBe("none");
  });

  it("2. no components (a plain line): line, today's chain", () => {
    expect(invoiceBarcodeSource({ unitSku: "U" }, [], true)).toBe("line");
    expect(invoiceBarcodeSource({ sku: "S" }, undefined, true)).toBe("line");
    expect(invoiceBarcodeSource(null, null, true)).toBe("line");
  });

  it("3. components and the pack has a unit code or a box barcode: line", () => {
    expect(invoiceBarcodeSource({ unitSku: "U" }, [piece("1"), piece("2")], true)).toBe("line");
    expect(invoiceBarcodeSource({ barcode: "B" }, [piece("1")], true)).toBe("line");
    expect(
      invoiceBarcodeSource({ unitSku: "U", barcode: "B", sku: "S" }, [piece(null)], true),
    ).toBe("line");
  });

  it("4. components, no pack code, at least one piece barcode: pieces (the item number sku alone does not count)", () => {
    expect(invoiceBarcodeSource({ sku: "PACK-1" }, [piece("1"), piece(null)], true)).toBe("pieces");
    expect(
      invoiceBarcodeSource({ unitSku: null, barcode: null, sku: null }, [piece("1")], true),
    ).toBe("pieces");
    expect(invoiceBarcodeSource({ unitSku: "", barcode: "", sku: "S" }, [piece("1")], true)).toBe(
      "pieces",
    );
  });

  it("5. components, no pack code, no piece barcode: line (today's chain, the item number)", () => {
    expect(invoiceBarcodeSource({ sku: "PACK-1" }, [piece(null), piece(null)], true)).toBe("line");
    expect(invoiceBarcodeSource(null, [piece(null)], true)).toBe("line");
  });
});
