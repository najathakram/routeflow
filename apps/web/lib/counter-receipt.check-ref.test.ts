import { buildCounterReceipt, receiptModelFromOrder } from "./counter-receipt";

const NOW = new Date("2026-10-07T15:30:00Z");

const live = (over: Record<string, unknown> = {}) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-00001",
      invoiceId: "i1",
      invoiceNumber: "INV-00001",
      total: 25,
      paid: 25,
      balanceDue: 0,
      paymentRecorded: true,
      method: "CHECK",
      ...over,
    } as never,
    lines: [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 10 }],
    enteredTender: null,
    profile: null,
    now: NOW,
  });

const reprint = (
  methods: Array<{ method: "CASH" | "CARD" | "CHECK"; amount: number }>,
  checkReference?: string | null,
  split = true,
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-00001",
      total: 25,
      lineItems: [{ id: "l1", name: "Cola", qty: 10, unitPrice: 2.5 }],
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-00001",
      paid: 25,
      balanceDue: 0,
      methods,
      ...(split ? { tenderPaid: 25, tenderMethods: methods } : {}),
      createdAt: "2026-10-07T15:15:00.000Z",
      checkReference,
    },
    profile: null,
  });

describe("W-713 / F11: the check number rides on the receipt and the reprint", () => {
  it("the live receipt reads 'Check #1042' beside the method", () => {
    expect(live({ checkReference: "1042" }).methodLabel).toBe("Check #1042");
  });
  it("a check with no number (an older server) stays 'Check'", () => {
    expect(live().methodLabel).toBe("Check");
  });
  it("card and cash are unchanged even if a reference arrives", () => {
    expect(live({ method: "CARD", checkReference: "1042" }).methodLabel).toBe("Card");
    expect(live({ method: "CASH", checkReference: "1042" }).methodLabel).toBe("Cash");
  });
  it("the reprint reads the number too, on the check leg only", () => {
    expect(reprint([{ method: "CHECK", amount: 25 }], "1042").methodLabel).toBe(
      "Check #1042 $25.00",
    );
    expect(
      reprint(
        [
          { method: "CASH", amount: 5 },
          { method: "CHECK", amount: 20 },
        ],
        "1042",
      ).methodLabel,
    ).toBe("Cash $5.00 + Check #1042 $20.00");
  });
  it("the reprint without a number, or for a card sale, is unchanged", () => {
    expect(reprint([{ method: "CHECK", amount: 25 }], null).methodLabel).toBe("Check $25.00");
    expect(reprint([{ method: "CARD", amount: 25 }], "1042").methodLabel).toBe("Card $25.00");
    expect(reprint([{ method: "CHECK", amount: 25 }], "1042", false).methodLabel).toBe(
      "Check #1042",
    );
  });
});
