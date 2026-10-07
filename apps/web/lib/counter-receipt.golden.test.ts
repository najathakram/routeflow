import { buildCounterReceipt, receiptModelFromOrder } from "./counter-receipt";

/**
 * Golden: for the SAME sale, the live receipt (`buildCounterReceipt`, from the cart) and the reprint
 * (`receiptModelFromOrder`, from the stored order) agree on everything the customer reads. Only what is never stored
 * (tendered, change) and the date label (sale time vs now) may differ.
 */
const PROFILE = {
  businessName: "Acme",
  street: "1 Main St",
  city: "Springfield",
  state: "IL",
  zip: "62701",
  phone: "555-0100",
};
const CART = [
  { tempId: "l1", name: "Cola", unitPrice: 2.5, qty: 3 },
  { tempId: "l2", name: "Water", unitPrice: 12, qty: 15, unitsPerBox: 12, boxes: 1, pieces: 3 },
];
const SOLD = new Date("2026-10-07T15:15:00.000Z");

const live = (method: "CASH" | "CARD" | "ON_ACCOUNT", over = {}) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 24.5,
      paid: method === "ON_ACCOUNT" ? 0 : 24.5,
      balanceDue: method === "ON_ACCOUNT" ? 24.5 : 0,
      change: method === "CASH" ? 5.5 : undefined,
      method,
      paymentRecorded: true,
    },
    lines: CART,
    enteredTender: null,
    profile: PROFILE,
    cashier: "pat",
    now: SOLD,
    ...over,
  });
type Tender = { method: "CASH" | "CARD" | "CHECK" | "OTHER" | "STORE_CREDIT"; amount: number };
const reprint = (
  methods: Tender[],
  paymentState: "PAID" | "ON_ACCOUNT" | "PARTLY_PAID" = "PAID",
  money: { paid: number; balanceDue: number } = {
    paid: paymentState === "ON_ACCOUNT" ? 0 : 24.5,
    balanceDue: paymentState === "ON_ACCOUNT" ? 24.5 : 0,
  },
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total: 24.5,
      lineItems: [
        { id: "l1", name: "Cola", qty: 3, unitPrice: 2.5 },
        { id: "l2", name: "Water", qty: 15, unitPrice: 12, unitsPerBox: 12, boxes: 1, pieces: 3 },
        { id: "l3", name: "Voided line", qty: 1, unitPrice: 99, status: "CANCELLED" },
      ],
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      paymentState,
      ...money,
      methods,
      createdAt: SOLD.toISOString(),
      timezone: "America/New_York",
    },
    profile: PROFILE,
    cashier: "pat",
  });

const SHARED = [
  "header",
  "orderNumber",
  "invoiceNumber",
  "invoiceId",
  "cashier",
  "subtotal",
  "adjustment",
  "total",
  "paid",
  "balanceDue",
  "methodLabel",
  "onAccount",
  "showPaid",
  "showBalance",
] as const;

describe("receipt golden: live vs reprint", () => {
  it.each([["CASH"], ["CARD"]] as const)(
    "%s sale: same header, lines, subtotal, adjustment, total, method, numbers",
    (m) => {
      const a = live(m);
      const b = reprint([{ method: m, amount: 24.5 }]);
      for (const k of SHARED) expect(b[k]).toEqual(a[k]);
      expect(b.lines).toEqual(a.lines.map((l) => ({ ...l, key: l.key })));
    },
  );
  it("on-account sale agrees too", () => {
    const a = live("ON_ACCOUNT");
    const b = reprint([], "ON_ACCOUNT");
    for (const k of SHARED) expect(b[k]).toEqual(a[k]);
  });
  it("the reprint never invents tendered or change; the live cash receipt has them", () => {
    expect(live("CASH").tendered).toBe(30);
    expect(live("CASH").change).toBe(5.5);
    const b = reprint([{ method: "CASH", amount: 24.5 }]);
    expect(b.tendered).toBeNull();
    expect(b.change).toBeNull();
  });
  it("a split tender reads 'Cash + Card'", () => {
    expect(
      reprint([
        { method: "CASH", amount: 10 },
        { method: "CARD", amount: 14.5 },
      ]).methodLabel,
    ).toBe("Cash + Card");
  });
  it("store credit is labelled, not hidden, and the date reads in the sale timezone", () => {
    const b = reprint([{ method: "STORE_CREDIT", amount: 24.5 }]);
    expect(b.methodLabel).toBe("Store credit");
    expect(b.dateLabel).toMatch(/11:15/);
  });
  it("uses the server's paid and balanceDue as given, whatever the tenders add up to", () => {
    const b = reprint([{ method: "CASH", amount: 9 }], "PARTLY_PAID", { paid: 15, balanceDue: 3 });
    expect(b.paid).toBe(15);
    expect(b.balanceDue).toBe(3);
  });
});
