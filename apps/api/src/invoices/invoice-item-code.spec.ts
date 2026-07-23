import { invoiceItemCode } from "./invoice-item-code";

describe("invoiceItemCode — unit code with legacy fallback", () => {
  it("prefers unitSku when set", () => {
    expect(invoiceItemCode({ unitSku: "UNIT-1", barcode: "BAR-1", sku: "SKU-1" })).toBe("UNIT-1");
  });

  it("falls back to barcode when unitSku is unset", () => {
    expect(invoiceItemCode({ unitSku: null, barcode: "BAR-1", sku: "SKU-1" })).toBe("BAR-1");
    expect(invoiceItemCode({ barcode: "BAR-1", sku: "SKU-1" })).toBe("BAR-1");
  });

  it("falls back to sku when unitSku and barcode are unset", () => {
    expect(invoiceItemCode({ unitSku: null, barcode: null, sku: "SKU-1" })).toBe("SKU-1");
  });

  it("returns null when unitSku, barcode, and sku are all unset", () => {
    expect(invoiceItemCode({ unitSku: null, barcode: null, sku: null })).toBeNull();
    expect(invoiceItemCode({})).toBeNull();
    expect(invoiceItemCode(null)).toBeNull();
    expect(invoiceItemCode(undefined)).toBeNull();
  });
});
