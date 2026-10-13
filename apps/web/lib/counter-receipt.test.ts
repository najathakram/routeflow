import { roundMoney } from "@routeflow/pricing";
import {
  buildCounterReceipt,
  formatReceiptMoney,
  formatSaleDayTime,
  formatSaleTime,
  type ReceiptLineInput,
} from "./counter-receipt";

const NOW = new Date("2026-10-07T15:30:00Z");
const PLAIN: ReceiptLineInput = { tempId: "a", name: "Cola", unitPrice: 2.5, qty: 3 };
const BOXED: ReceiptLineInput = {
  tempId: "b",
  name: "Water",
  unitPrice: 12,
  qty: 15,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 3,
};
const sale = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  paymentRecorded: true,
  method: "CASH" as const,
  ...over,
});
const build = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  buildCounterReceipt({
    receipt: sale(over) as never,
    lines: [PLAIN, BOXED],
    enteredTender: null,
    profile: null,
    now: NOW,
    ...extra,
  });

describe("buildCounterReceipt", () => {
  it("prices a plain line as qty x unit = total and a boxed line through the pricing package", () => {
    const m = build();
    expect(m.lines[0]).toMatchObject({ name: "Cola", total: 7.5 });
    expect(m.lines[0].detail).toBe("3 × $2.50");
    // 1 box + 3 pcs of 12 at $12/box = 12 + 3 = 15, never 15 * 12
    expect(m.lines[1]).toMatchObject({ name: "Water", total: 15 });
    expect(m.lines[1].detail).toBe("1 box + 3 pcs × $12.00 per box");
  });

  it("header: name, address and phone from the settings answer; name only when that is all there is", () => {
    const full = build(
      {},
      {
        profile: {
          businessName: "Acme Foods",
          street: "1 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
          phone: "555-0100",
        },
      },
    );
    expect(full.header).toEqual({
      name: "Acme Foods",
      addressLines: ["1 Main St", "Springfield, IL 62701"],
      phone: "555-0100",
    });
    const nameOnly = build(
      {},
      { profile: { businessName: "Acme Foods", street: "  ", phone: "" } },
    );
    expect(nameOnly.header).toEqual({ name: "Acme Foods", addressLines: [], phone: null });
    expect(build().header).toEqual({ name: null, addressLines: [], phone: null });
  });

  it("number and date", () => {
    const m = build();
    expect(m.orderNumber).toBe("ORD-1");
    expect(m.invoiceNumber).toBe("INV-1");
    expect(m.dateLabel).toMatch(/2026/);
  });

  it("cash with change: tendered = paid + change", () => {
    const m = build({ paid: 22.5, change: 7.5 });
    expect(m.methodLabel).toBe("Cash");
    expect(m.tendered).toBe(30);
    expect(m.change).toBe(7.5);
    expect(m.changeAsEntered).toBe(false);
  });

  it("cash with zero change: tendered shown, no change figure", () => {
    const m = build({ paid: 22.5 });
    expect(m.tendered).toBe(22.5);
    expect(m.change).toBeNull();
  });

  it("card: paid and method, no change", () => {
    const m = build({ method: "CARD", paid: 22.5 });
    expect(m.methodLabel).toBe("Card");
    expect(m.tendered).toBeNull();
    expect(m.change).toBeNull();
  });

  it("recovered cash sale uses the entered tender, labelled as entered", () => {
    const m = build({ paid: 22.5 }, { enteredTender: 40 });
    expect(m.tendered).toBe(40);
    expect(m.change).toBe(17.5);
    expect(m.changeAsEntered).toBe(true);
  });

  it("on account and payment-not-recorded show no tender", () => {
    const acct = build({ method: "ON_ACCOUNT", paid: 0, balanceDue: 22.5 });
    expect(acct.onAccount).toBe(true);
    expect(acct.tendered).toBeNull();
    const bad = build({ paymentRecorded: false, paid: 0, balanceDue: 22.5 });
    expect(bad.paymentNotRecorded).toBe(true);
    expect(bad.methodLabel).toBeNull();
    expect(bad.tendered).toBeNull();
  });

  it("formats money", () => {
    expect(formatReceiptMoney(2.5)).toBe("$2.50");
    expect(formatReceiptMoney(-1)).toBe("-$1.00");
    expect(formatReceiptMoney(0)).toBe("$0.00");
  });

  it("subtotal + adjustments reconcile to the server total, also for a repriced sale", () => {
    const same = build({ total: 22.5 });
    expect(same.subtotal).toBe(22.5);
    expect(same.adjustments).toBe(0);
    const repriced = build({ total: 24.75, paid: 24.75 });
    expect(repriced.subtotal).toBe(22.5);
    expect(repriced.adjustments).toBe(2.25);
    expect(roundMoney(repriced.subtotal + repriced.adjustments)).toBe(repriced.total);
  });

  it("falls back to the rung method when the response has none; carries the cashier", () => {
    const m = build(
      { method: undefined, paid: 22.5, change: 7.5 },
      { fallbackMethod: "CASH", cashier: " pat " },
    );
    expect(m.methodLabel).toBe("Cash");
    expect(m.tendered).toBe(30);
    expect(m.cashier).toBe("pat");
  });
});

describe("formatSaleDayTime (the reprint label's 'Sold Sun, Oct 11, 2:46 PM')", () => {
  it("reads the sale's own day and time in the sale's zone, day label from the shared helper", () => {
    expect(formatSaleDayTime("2026-10-11T18:46:00.000Z", "America/New_York")).toBe(
      "Sun, Oct 11, 2:46 PM",
    );
  });
  it("a sale near midnight keeps the zone's calendar day, not UTC's", () => {
    expect(formatSaleDayTime("2026-10-08T02:30:00.000Z", "America/New_York")).toBe(
      "Wed, Oct 7, 10:30 PM",
    );
  });
  it("an unknown zone falls back to UTC and never throws", () => {
    expect(formatSaleDayTime("2026-10-11T18:46:00.000Z", "Not/AZone")).toBe("Sun, Oct 11, 6:46 PM");
  });
});

describe("formatSaleTime", () => {
  const at = "2026-10-07T15:15:00.000Z";
  it("reads the time in the given IANA zone", () => {
    expect(formatSaleTime(at, "America/New_York")).toBe("Oct 7, 2026, 11:15 AM");
  });
  it("a zone that is not IANA (free-text tenant setting) falls back to UTC, never throws", () => {
    expect(() => formatSaleTime(at, "Not/AZone")).not.toThrow();
    expect(formatSaleTime(at, "Not/AZone")).toBe("Oct 7, 2026, 3:15 PM");
  });
});

describe("browser zone must never leak into the receipt (SA-738)", () => {
  const at = "2026-10-07T03:15:00.000Z"; // Oct 6, 8:15 PM in Los Angeles; Oct 7, 3:15 AM UTC
  const prevTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it("formatSaleTime with no zone reads UTC, not the browser's zone", () => {
    expect(formatSaleTime(at)).toBe("Oct 7, 2026, 3:15 AM");
  });

  it("the live receipt with no profile zone prints UTC under a non-UTC process TZ", () => {
    const m = buildCounterReceipt({
      receipt: sale() as never,
      lines: [PLAIN],
      enteredTender: null,
      profile: null,
      now: new Date(at),
    });
    expect(m.dateLabel).toBe("Oct 7, 2026, 3:15 AM");
  });
});

describe("row 298: the receipt line names the product's unit", () => {
  const detailOf = (line: object) =>
    buildCounterReceipt({
      receipt: {
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.5,
        paid: 2.5,
        balanceDue: 0,
        method: "CARD",
        paymentRecorded: true,
      } as never,
      lines: [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 1, ...line }],
      enteredTender: null,
      profile: null,
      now: new Date("2026-10-07T15:15:00Z"),
    }).lines[0].detail;

  it("a plain line prints the unit word after the price", () => {
    expect(detailOf({ unit: "each" })).toBe("1 × $2.50 each");
    expect(detailOf({ unit: " LB ", qty: 3 })).toBe("3 × $2.50 per lb");
  });
  it("a line with no unit on file keeps the bare form", () => {
    expect(detailOf({})).toBe("1 × $2.50");
  });
  it("a boxed line keeps its per-box wording", () => {
    expect(detailOf({ unit: "each", unitsPerBox: 12, boxes: 1, pieces: 0, qty: 12 })).toBe(
      "1 box × $2.50 per box",
    );
  });
});
