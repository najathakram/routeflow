import { deriveInvoiceVariant } from "./invoice-pdf-variant";

describe("deriveInvoiceVariant — draft vs final default", () => {
  it("is DRAFT while the invoice is a DRAFT mirror and the order is not delivered", () => {
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "PENDING" } })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "CONFIRMED" } })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: null })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT" })).toBe("draft");
  });

  it("is FINAL once the order is delivered, even while the invoice is still DRAFT", () => {
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "DELIVERED" } })).toBe("final");
  });

  it("is FINAL once the invoice is issued (any status beyond DRAFT)", () => {
    for (const status of ["SENT", "VIEWED", "PARTIAL", "PAID", "OVERDUE"]) {
      expect(deriveInvoiceVariant({ status, order: { status: "PENDING" } })).toBe("final");
    }
  });
});
