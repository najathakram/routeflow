import { deriveInvoiceVariant } from "@/lib/api/invoices";

describe("deriveInvoiceVariant honours the server's pdfVariant (F3)", () => {
  it("a shipment invoice (server says final) is FINAL while the order is not delivered", () => {
    expect(
      deriveInvoiceVariant({
        status: "DRAFT",
        pdfVariant: "final",
        order: { status: "OUT_FOR_DELIVERY" },
      }),
    ).toBe("final");
  });

  it("the server's draft wins too, and an absent field falls back to today's rule", () => {
    expect(
      deriveInvoiceVariant({
        status: "DRAFT",
        pdfVariant: "draft",
        order: { status: "DELIVERED" },
      }),
    ).toBe("draft");
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "OUT_FOR_DELIVERY" } })).toBe(
      "draft",
    );
    expect(deriveInvoiceVariant({ status: "DRAFT", order: { status: "DELIVERED" } })).toBe("final");
    expect(deriveInvoiceVariant({ status: "SENT" })).toBe("final");
  });
});
