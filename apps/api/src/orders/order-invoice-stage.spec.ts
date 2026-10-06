/**
 * Fold 4: the order read stamps each invoice with the server's default PDF stage (`pdfVariant`), so the
 * web can ask for a confirm before "Unmark shipped" turns a FINAL invoice back into a draft. Same
 * predicate as the invoice detail (`resolveInvoiceVariant`); nothing is derived in a client.
 */
import { attachInvoiceStages } from "./order-invoice-stage";

const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
const order = (over: Record<string, unknown> = {}) => ({
  id: "ord-1",
  tenantId: "t1",
  status: "OUT_FOR_DELIVERY",
  fulfillPath: "SHIP",
  shippedAt: new Date("2026-06-20T00:00:00.000Z"),
  invoices: [
    { id: "i1", status: "DRAFT", deliveryBatchId: null } as Record<string, unknown>,
    { id: "i2", status: "SENT", deliveryBatchId: null } as Record<string, unknown>,
    { id: "i3", status: "VOID", deliveryBatchId: null } as Record<string, unknown>,
  ],
  ...over,
});

describe("attachInvoiceStages", () => {
  it("a shipped SHIP order of a shipping business: its draft shipment invoice and its issued invoice are final", async () => {
    const o = order();
    await attachInvoiceStages(cfg("ship"), o);
    expect(o.invoices.map((i) => i.pdfVariant)).toEqual(["final", "final", "final"]);
  });

  it("unchanged: an unset-mode business keeps the draft a draft (issued stays final)", async () => {
    const o = order();
    await attachInvoiceStages(cfg("unset"), o);
    expect(o.invoices.map((i) => i.pdfVariant)).toEqual(["draft", "final", "final"]);
  });

  it("an order with no invoices is untouched", async () => {
    const o = order({ invoices: undefined });
    await expect(attachInvoiceStages(cfg("ship"), o)).resolves.toBeUndefined();
  });
});
