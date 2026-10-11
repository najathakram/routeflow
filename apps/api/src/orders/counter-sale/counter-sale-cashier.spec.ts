import { cashierNameOf } from "./counter-sale-cashier";
import { pageQuery, toTodaysSaleRow, type TodayOrderRecord } from "./counter-sale-today";

/**
 * Row 317: who rang the sale. `Order.soldById` is stamped by the counter write; the read shows the staff user's
 * display name (their `username`, the name every staff list prints), never an email, and is null-safe for old rows.
 * Placeholders only (acme).
 */
describe("cashierNameOf: the ONE display name of the cashier", () => {
  it("is the trimmed username", () => {
    expect(cashierNameOf({ username: "  jane  " })).toBe("jane");
  });

  it("is null for an old row (no soldBy), a missing or blank username", () => {
    expect(cashierNameOf(null)).toBeNull();
    expect(cashierNameOf(undefined)).toBeNull();
    expect(cashierNameOf({ username: null })).toBeNull();
    expect(cashierNameOf({ username: "   " })).toBeNull();
  });

  it("never prints an email: an email-shaped username reads as no cashier", () => {
    expect(cashierNameOf({ username: "jane@acme.test" })).toBeNull();
  });
});

describe("Today's-sales row: cashierName", () => {
  const rec = (soldBy?: TodayOrderRecord["soldBy"]): TodayOrderRecord => ({
    id: "o-1",
    orderNumber: "1042",
    status: "DELIVERED",
    total: "24.50",
    createdAt: new Date("2026-10-07T18:14:00.000Z"),
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [{ id: "i-1", invoiceNumber: "INV-1", status: "PAID", payments: [] }],
    returns: [],
    ...(soldBy === undefined ? {} : { soldBy }),
  });

  it("carries the cashier's name", () => {
    expect(toTodaysSaleRow(rec({ username: "jane" })).cashierName).toBe("jane");
  });

  it("is null for a sale rung before soldById was stamped", () => {
    expect(toTodaysSaleRow(rec(null)).cashierName).toBeNull();
    expect(toTodaysSaleRow(rec()).cashierName).toBeNull();
  });

  it("the page query reads the cashier's username only (no email, no other user column)", () => {
    const q = pageQuery("t-1", { start: new Date(0), end: new Date(1) }, 1, 20);
    expect(q.select.soldBy).toEqual({ select: { username: true } });
  });
});
