import { buildCounterReceipt, receiptModelFromOrder } from "./counter-receipt";

/**
 * CQ-03: the levy (CRV deposit, excise) is its own named charge on the live receipt and the reprint: never inside Tax,
 * never an unexplained "Adjustments"; an exempt customer's older order prints no Tax and then reverses it.
 */
const CART = [{ tempId: "a", name: "Cola", unitPrice: 10, qty: 4 }]; // net subtotal $40.00
const SOLD = new Date("2026-10-07T15:15:00.000Z");
const CRV = { key: "cat-crv", label: "CRV deposit", amount: 1.6 };

const live = (total: number, over: { tax?: number; charges?: (typeof CRV)[] } = {}) =>
  buildCounterReceipt({
    receipt: {
      tax: over.tax ?? 3.3,
      taxRatePercent: 8.25,
      ...(over.charges ? { charges: over.charges } : {}),
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total,
      paid: total,
      balanceDue: 0,
      method: "CARD",
      paymentRecorded: true,
    },
    lines: CART,
    enteredTender: null,
    profile: { taxRate: 8.25 },
    now: SOLD,
  });

const reprint = (total: number, tax: number, charges?: (typeof CRV)[]) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total,
      tax,
      lineItems: [{ id: "l1", name: "Cola", qty: 4, unitPrice: 10 }],
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      paid: total,
      balanceDue: 0,
      methods: [{ method: "CASH", amount: total }],
      createdAt: "2026-10-07T15:15:00.000Z",
      taxRatePercent: 8.25,
      ...(charges ? { charges } : {}),
    },
    profile: null,
  });

describe("receipt charges (CQ-03)", () => {
  it("live: 40.00 + 3.30 tax + 1.60 CRV deposit = 44.90, the deposit its own row and no Adjustments", () => {
    const m = live(44.9, { charges: [CRV] });
    expect(m.tax).toBe(3.3);
    expect(m.charges).toEqual([CRV]);
    expect(m.adjustments).toBe(0);
    expect(m.taxRatePercent).toBe(8.25); // the rate still explains the Tax row alone
  });

  it("reprint: the same sale prints the same rows", () => {
    const m = reprint(44.9, 3.3, [CRV]);
    expect(m.tax).toBe(3.3);
    expect(m.charges).toEqual([CRV]);
    expect(m.adjustments).toBe(0);
    expect(m.taxRatePercent).toBe(8.25);
  });

  it("an older server that sends no charges folds nothing: the remainder stays Adjustments as before", () => {
    const m = live(44.9);
    expect(m.charges).toEqual([]);
    expect(m.adjustments).toBe(1.6);
  });

  it("an exempt customer's older order: tax the total never carried is not printed and reversed", () => {
    expect(live(40, { tax: 3.3 })).toMatchObject({ tax: 0, adjustments: 0, charges: [] });
    expect(reprint(40, 3.3)).toMatchObject({ tax: 0, adjustments: 0, charges: [] });
  });

  it("a real re-price below the tax stays an Adjustment", () => {
    expect(live(42.8, { tax: 3.3 })).toMatchObject({ tax: 3.3, adjustments: -0.5 });
  });
});
