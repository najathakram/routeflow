import { inferBarcodeSymbology } from "./barcode-symbology";

// T3 (R3, #2717 M1): symbology inferred purely from the trimmed code's digit-length.
describe("inferBarcodeSymbology (#2717 M1, SA-572a)", () => {
  it("infers UPC_A from a 12-digit numeric code", () => {
    expect(inferBarcodeSymbology("036000291452")).toBe("UPC_A");
  });

  it("infers EAN_13 from a 13-digit numeric code", () => {
    expect(inferBarcodeSymbology("4006381333931")).toBe("EAN_13");
  });

  it("infers GTIN_14 from a 14-digit numeric code", () => {
    expect(inferBarcodeSymbology("10012345678902")).toBe("GTIN_14");
  });

  it("infers EAN_8 from an 8-digit numeric code", () => {
    expect(inferBarcodeSymbology("96385074")).toBe("EAN_8");
  });

  it("falls back to CODE128 for non-digit codes", () => {
    expect(inferBarcodeSymbology("ABC-123")).toBe("CODE128");
  });

  it("falls back to CODE128 for a digit-only code of an unrecognized length (SA-572b Q1)", () => {
    expect(inferBarcodeSymbology("12345")).toBe("CODE128");
  });

  it("trims surrounding whitespace before inferring", () => {
    expect(inferBarcodeSymbology(" 036000291452 ")).toBe("UPC_A");
  });
});
