import { UNMARK_FINAL_INVOICE_COPY, orderHasFinalInvoice } from "@/lib/unmark-shipped";

describe("orderHasFinalInvoice (fold 4)", () => {
  it("true when a live invoice is final", () => {
    expect(orderHasFinalInvoice({ invoices: [{ status: "DRAFT", pdfVariant: "final" }] })).toBe(
      true,
    );
  });

  it("false for a draft invoice, a void final one, no invoices, or a server without the field", () => {
    expect(orderHasFinalInvoice({ invoices: [{ status: "DRAFT", pdfVariant: "draft" }] })).toBe(
      false,
    );
    expect(orderHasFinalInvoice({ invoices: [{ status: "VOID", pdfVariant: "final" }] })).toBe(
      false,
    );
    expect(orderHasFinalInvoice({ invoices: [] })).toBe(false);
    expect(orderHasFinalInvoice({})).toBe(false);
    expect(orderHasFinalInvoice({ invoices: [{ status: "SENT" }] })).toBe(false);
  });

  it("carries the approved copy", () => {
    expect(UNMARK_FINAL_INVOICE_COPY).toBe(
      "This order's invoice was issued as final. Unmarking turns it back into a draft that can change. Continue?",
    );
  });
});
