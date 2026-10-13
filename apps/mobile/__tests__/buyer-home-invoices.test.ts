/**
 * Must-fix 1 (row 318 review): the buyer Home balance strip. Its query dropped VIEWED
 * (["SENT", "OVERDUE", "PARTIAL"]) and its overdue count re-derived overdue from `status === "OVERDUE"`.
 * It now asks for the shared open set and counts the server's `isOverdue` flag (the one rule: open status AND
 * balance due AND the due day ended in the seller's zone), so a past-due PARTIAL counts and a stale OVERDUE
 * status whose due day has not ended does not.
 */
import { buyerHomeInvoiceParams, buyerHomeOverdueCount } from "../lib/buyer-home-invoices";

describe("buyerHomeInvoiceParams", () => {
  it("asks for the whole open set, VIEWED included", () => {
    expect([...(buyerHomeInvoiceParams().statuses ?? [])].sort()).toEqual([
      "OVERDUE",
      "PARTIAL",
      "SENT",
      "VIEWED",
    ]);
    expect(buyerHomeInvoiceParams().limit).toBe(50);
  });
});

describe("buyerHomeOverdueCount", () => {
  it("counts the server's isOverdue flag, not the OVERDUE status", () => {
    expect(
      buyerHomeOverdueCount([
        { status: "PARTIAL", isOverdue: true }, // past due, still owes: counts (status is not OVERDUE)
        { status: "OVERDUE", isOverdue: false }, // stale status, due day not ended: does not
        { status: "SENT", isOverdue: false },
        { status: "OVERDUE" }, // no flag from the server: unknown is not overdue
        { status: "VIEWED", isOverdue: true },
      ]),
    ).toBe(2);
  });

  it("is 0 for no invoices", () => {
    expect(buyerHomeOverdueCount([])).toBe(0);
    expect(buyerHomeOverdueCount(undefined)).toBe(0);
  });
});
