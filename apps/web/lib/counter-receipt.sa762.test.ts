import {
  buildCounterReceipt,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "./counter-receipt";

/**
 * SA-762r (Web-1 #9): the receipt prints the customer's name when named (never for a walk-in), splits "Tax and adjustments"
 * into Tax and, only when non-zero, Adjustments, takes the live receipt's Tax and rate from the response, and carries the business's
 * footer. Live and reprint share ONE label formatter (adjustmentLabel).
 */
const CART = [{ tempId: "a", name: "Cola", unitPrice: 10, qty: 4 }]; // net subtotal $40.00
const SOLD = new Date("2026-10-07T15:15:00.000Z");

const live = (
  total: number,
  over: {
    customerName?: string | null;
    profile?: ReceiptBusinessProfile;
    /** the response's server-owned tax figure and stored rate candidate (an older server sends neither) */
    tax?: number;
    taxRatePercent?: number | null;
  } = {},
) =>
  buildCounterReceipt({
    receipt: {
      ...(over.tax == null ? {} : { tax: over.tax, taxRatePercent: over.taxRatePercent ?? null }),
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
    profile: over.profile ?? { taxRate: 8.25 }, // the settings rate is NOT a money source
    customerName: over.customerName,
    now: SOLD,
  });

const reprint = (
  total: number,
  tax: number | undefined,
  facts: {
    customerName?: string | null;
    taxRatePercent?: number | null;
    cashTendered?: number | null;
    change?: number | null;
  } = {},
  profile: ReceiptBusinessProfile | null = null,
) =>
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
      ...facts,
    },
    profile,
  });

describe("customer name", () => {
  it("a named customer prints on the live receipt and the reprint; a walk-in prints none", () => {
    expect(live(43.3, { customerName: "  Acme Co " }).customerName).toBe("Acme Co");
    expect(live(43.3, { customerName: null }).customerName).toBeNull();
    expect(live(43.3).customerName).toBeNull();
    expect(reprint(43.3, 3.3, { customerName: "Acme Co" }).customerName).toBe("Acme Co");
    expect(reprint(43.3, 3.3, { customerName: null }).customerName).toBeNull();
    expect(reprint(43.3, 3.3).customerName).toBeNull();
  });
});

describe("Tax and Adjustments are separate rows", () => {
  it("live: the server's tax and stored rate are Tax (8.25%), with no Adjustments", () => {
    const m = live(43.3, { tax: 3.3, taxRatePercent: 8.25 });
    expect(m.tax).toBe(3.3);
    expect(m.taxRatePercent).toBe(8.25);
    expect(m.adjustments).toBe(0);
  });

  it("live: what remains after the server's tax is Adjustments, and the rate stays on Tax", () => {
    const m = live(44, { tax: 3.3, taxRatePercent: 8.25 });
    expect(m.tax).toBe(3.3);
    expect(m.taxRatePercent).toBe(8.25);
    expect(m.adjustments).toBe(0.7);
  });

  it("live: a rate that does not reproduce the server's tax is not named (plain Tax)", () => {
    const m = live(43.8, { tax: 3.8, taxRatePercent: 8.25 });
    expect(m.tax).toBe(3.8);
    expect(m.taxRatePercent).toBeNull();
    expect(m.adjustments).toBe(0);
  });

  it("live: the settings rate is never a money source: with no server tax figure the whole difference is Adjustments", () => {
    const m = live(43.3); // settings taxRate 8.25 would explain it, but the response carries no tax
    expect(m.tax).toBe(0);
    expect(m.taxRatePercent).toBeNull();
    expect(m.adjustments).toBe(3.3);
  });

  it("reprint: Tax is the order's tax, with no % when the rate is unknown, and Adjustments is the rest", () => {
    const m = reprint(43.3, 3.3);
    expect(m.tax).toBe(3.3);
    expect(m.taxRatePercent).toBeNull();
    expect(m.adjustments).toBe(0);
    const repriced = reprint(44.3, 3.3);
    expect(repriced.tax).toBe(3.3);
    expect(repriced.adjustments).toBe(1);
  });

  it("reprint with the stored rate names it: Tax (8.25%)", () => {
    expect(reprint(43.3, 3.3, { taxRatePercent: 8.25 }).taxRatePercent).toBe(8.25);
  });

  it("an old fixture without a tax figure calls nothing tax", () => {
    const m = reprint(43.3, undefined);
    expect(m.tax).toBe(0);
    expect(m.adjustments).toBe(3.3);
  });

  it("reprint with a cash tender: Tendered, and the Change the server served (SA-764 still holds)", () => {
    const m = reprint(43.3, 3.3, { cashTendered: 50, change: 6.7 });
    expect(m.tendered).toBe(50);
    expect(m.change).toBe(6.7);
  });
});

describe("receipt footer", () => {
  it("is the trimmed settings footer on both receipts; blank or absent prints none", () => {
    const profile = { receiptFooter: "  Thanks!\nReturns within 7 days  " };
    expect(live(43.3, { profile }).footer).toBe("Thanks!\nReturns within 7 days");
    expect(reprint(43.3, 3.3, {}, profile).footer).toBe("Thanks!\nReturns within 7 days");
    expect(live(43.3, { profile: { receiptFooter: "   " } }).footer).toBeNull();
    expect(live(43.3, { profile: {} }).footer).toBeNull();
    expect(reprint(43.3, 3.3).footer).toBeNull();
  });
});

describe("GET /orders/:id Decimals arrive as strings", () => {
  it("a string tax and total still split into Tax (8.25%) with no Adjustments", () => {
    const m = receiptModelFromOrder({
      order: {
        orderNumber: "ORD-1",
        total: "43.30" as unknown as number,
        tax: "3.30" as unknown as number,
        lineItems: [{ id: "l1", name: "Cola", qty: 4, unitPrice: "10.00" as unknown as number }],
      },
      sale: {
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        paid: 43.3,
        balanceDue: 0,
        methods: [{ method: "CARD", amount: 43.3 }],
        createdAt: "2026-10-07T15:15:00.000Z",
        taxRatePercent: 8.25,
      },
      profile: null,
    });
    expect(m.tax).toBe(3.3);
    expect(m.total).toBe(43.3);
    expect(m.adjustments).toBe(0);
    expect(m.taxRatePercent).toBe(8.25);
  });
});
