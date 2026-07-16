import { deriveInvoiceVariant } from "../lib/invoice-pdf-variant";

// Truth table mirrored from apps/api/src/invoices/invoice-pdf-variant.spec-equivalent
// and apps/web/lib/api/invoices.ts#deriveInvoiceVariant — the three MUST agree.
describe("deriveInvoiceVariant (mobile mirror of api/web)", () => {
  it("DRAFT invoice on a not-yet-delivered order → draft", () => {
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "PENDING" } })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "CONFIRMED" } })).toBe("draft");
  });

  it("DRAFT invoice with no linked order → draft", () => {
    expect(deriveInvoiceVariant({ status: "DRAFT" })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: null })).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: null } })).toBe("draft");
  });

  it("DRAFT invoice whose order is DELIVERED → final (the pre-delivery mirror is done)", () => {
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "DELIVERED" } })).toBe("final");
  });

  it("issued invoice (status beyond DRAFT) → final regardless of the order", () => {
    for (const status of ["SENT", "PARTIAL", "PAID", "OVERDUE", "VOID", "WRITTEN_OFF"]) {
      expect(deriveInvoiceVariant({ status, order: { status: "PENDING" } })).toBe("final");
      expect(deriveInvoiceVariant({ status })).toBe("final");
    }
  });
});
