/**
 * The cancel warning is the only thing between a tap and voiding live invoices,
 * so its wording is pinned here — including the case where money moves and the
 * case where the cancel is refused outright.
 */
import { describeCancelImpact } from "../lib/cancel-impact";

const base = {
  invoicesToVoid: [],
  creditsToRestore: [],
  advanceToRestore: 0,
  blockingPayments: [],
  canCancel: true,
};

describe("describeCancelImpact", () => {
  it("says nothing extra when the order has no invoices or credits", () => {
    const copy = describeCancelImpact({ ...base });
    expect(copy.lines).toEqual([]);
    expect(copy.blockedReason).toBeNull();
    expect(copy.confirmLabel).toBe("Cancel order");
  });

  it("names the invoices that will be voided", () => {
    const copy = describeCancelImpact({
      ...base,
      invoicesToVoid: [
        { invoiceNumber: "INV-1", status: "SENT", total: 40 },
        { invoiceNumber: "INV-2", status: "DRAFT", total: 60 },
      ],
    });
    expect(copy.lines[0]).toBe("2 invoices will be voided: INV-1, INV-2.");
  });

  it("uses the singular for one invoice", () => {
    const copy = describeCancelImpact({
      ...base,
      invoicesToVoid: [{ invoiceNumber: "INV-9", status: "SENT", total: 10 }],
    });
    expect(copy.lines[0]).toBe("1 invoice will be voided: INV-9.");
  });

  it("states exactly where each credit goes back to", () => {
    const copy = describeCancelImpact({
      ...base,
      invoicesToVoid: [{ invoiceNumber: "INV-3", status: "PAID", total: 50 }],
      creditsToRestore: [
        { creditNoteNumber: "CN-7", amount: 50 },
        { creditNoteNumber: "CN-8", amount: 12.5 },
      ],
    });
    expect(copy.lines).toEqual([
      "1 invoice will be voided: INV-3.",
      "$50.00 goes back to credit note CN-7.",
      "$12.50 goes back to credit note CN-8.",
    ]);
  });

  it("mentions an advance balance separately from credit notes", () => {
    const copy = describeCancelImpact({ ...base, advanceToRestore: 25 });
    expect(copy.lines).toEqual(["$25.00 returns to the customer's advance balance."]);
  });

  it("refuses and explains when real money was taken", () => {
    const copy = describeCancelImpact({
      ...base,
      canCancel: false,
      blockingPayments: [{ invoiceNumber: "INV-7", amount: 80 }],
    });
    expect(copy.title).toBe("Can't cancel yet");
    expect(copy.confirmLabel).toBeNull();
    expect(copy.blockedReason).toContain("$80.00 on INV-7");
    expect(copy.blockedReason).toContain("Refund or reverse");
  });

  it("falls back to a plain prompt before the preview loads", () => {
    const copy = describeCancelImpact(undefined);
    expect(copy.title).toBe("Cancel this order?");
    expect(copy.confirmLabel).toBe("Cancel order");
  });
});
