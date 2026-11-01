import { createInvoiceVariant } from "./create-invoice-variant";

describe("createInvoiceVariant (SA-1066 M2)", () => {
  it("PENDING and editing are secondary, as before", () => {
    expect(createInvoiceVariant("PENDING", false, false)).toBe("secondary");
    expect(createInvoiceVariant("CONFIRMED", true, false)).toBe("secondary");
  });

  it("a POS order at Ready is secondary: Hand over is the one primary", () => {
    expect(createInvoiceVariant("OUT_FOR_DELIVERY", false, true)).toBe("secondary");
  });

  it("guard: a non-POS order at the same status, and a POS order earlier, stay primary", () => {
    expect(createInvoiceVariant("OUT_FOR_DELIVERY", false, false)).toBe("primary");
    expect(createInvoiceVariant("CONFIRMED", false, true)).toBe("primary");
  });
});
