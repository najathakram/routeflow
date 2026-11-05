import { pickCustomerInvoiceFields } from "./staff-only-fields";

/**
 * Owner ruling 2026-11-04: the business's `invoice.hidePerPiece` rides the invoice payload (like hideOriginalPrice), so a
 * CUSTOMER viewer of the same document (the buyer portal) honours it too. The customer allow-list must keep the flag.
 */
describe("pickCustomerInvoiceFields — hidePerPiece", () => {
  it("keeps the tenant's hidePerPiece for a customer viewer", () => {
    const out = pickCustomerInvoiceFields({ id: "i1", hidePerPiece: true, items: [] } as never);
    expect((out as { hidePerPiece?: boolean }).hidePerPiece).toBe(true);
  });
});
