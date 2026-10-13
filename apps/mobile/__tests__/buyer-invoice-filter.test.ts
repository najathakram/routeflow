/**
 * Row 318e (SA-770): the buyer Invoices screen's chips -> /buyer/invoices query params.
 *
 * The "Unpaid" chip sent statuses ["SENT", "OVERDUE"], so a VIEWED invoice (the buyer opened it) and a PARTIAL
 * one (part-paid, still owing) vanished from "Unpaid" while the dashboard counted them. "Unpaid" is the OPEN set
 * (the same four statuses as the API's OPEN_INVOICE_STATUSES and the staff list's overdue set); "Overdue" stays
 * the derived `isOverdue` filter (R4: the sweep never flips PARTIAL to OVERDUE, so a strict status misses it).
 */
import { buyerInvoiceQuery, BUYER_UNPAID_STATUSES } from "../lib/buyer-invoice-filter";

describe("buyerInvoiceQuery", () => {
  it("Unpaid is the whole open set: SENT, VIEWED, PARTIAL and OVERDUE", () => {
    expect([...BUYER_UNPAID_STATUSES].sort()).toEqual(["OVERDUE", "PARTIAL", "SENT", "VIEWED"]);
    expect(buyerInvoiceQuery("UNPAID")).toEqual({
      status: undefined,
      statuses: [...BUYER_UNPAID_STATUSES],
      isOverdue: undefined,
    });
  });

  it("Overdue is the derived isOverdue filter, never a strict status", () => {
    expect(buyerInvoiceQuery("OVERDUE")).toEqual({
      status: undefined,
      statuses: undefined,
      isOverdue: true,
    });
  });

  it("All sends no filter; Paid sends the single status", () => {
    expect(buyerInvoiceQuery("ALL")).toEqual({
      status: undefined,
      statuses: undefined,
      isOverdue: undefined,
    });
    expect(buyerInvoiceQuery("PAID")).toEqual({
      status: "PAID",
      statuses: undefined,
      isOverdue: undefined,
    });
  });

  it("never mixes a status with the isOverdue filter", () => {
    for (const id of ["ALL", "UNPAID", "PAID", "OVERDUE"] as const) {
      const q = buyerInvoiceQuery(id);
      expect(Boolean(q.isOverdue) && (q.status != null || q.statuses != null)).toBe(false);
    }
  });
});
