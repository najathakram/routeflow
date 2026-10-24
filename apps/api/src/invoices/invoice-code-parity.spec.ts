import { legacyInvoiceCode } from "@routeflow/pricing";
import { invoiceItemCode } from "./invoice-item-code";

/**
 * T16 / F2: the pricing package's `legacyInvoiceCode` is today's `invoiceItemCode`, for every null / "" / value combination of
 * unitSku, barcode and sku (3 x 3 x 3 = 27). The empty string is pinned as master has it: `??` keeps "" (it does not fall
 * through to the next code). This is the only copy of the guard.
 */
type Codes = { unitSku: string | null; barcode: string | null; sku: string | null };
const states = (col: string): (string | null)[] => [null, "", `${col}-1`];

const cases: Codes[] = states("U").flatMap((unitSku) =>
  states("B").flatMap((barcode) => states("S").map((sku) => ({ unitSku, barcode, sku }))),
);

describe("T16: legacyInvoiceCode is byte-identical to invoiceItemCode", () => {
  it("covers all 27 combinations", () => {
    expect(cases).toHaveLength(27);
  });

  it.each(cases.map((c) => [JSON.stringify(c), c] as const))("%s", (_name, p) => {
    expect(legacyInvoiceCode(p)).toBe(invoiceItemCode(p));
  });

  it("null and undefined products give null in both", () => {
    expect(legacyInvoiceCode(null)).toBe(invoiceItemCode(null));
    expect(legacyInvoiceCode(undefined)).toBe(invoiceItemCode(undefined));
  });

  it("keeps master's reading of the empty string (not skipped)", () => {
    expect(invoiceItemCode({ unitSku: "", barcode: "B", sku: "S" })).toBe("");
    expect(invoiceItemCode({ unitSku: null, barcode: "", sku: "S" })).toBe("");
  });
});
