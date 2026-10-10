import { InvoiceStatus } from "@prisma/client";
import { importPaymentStatus } from "./import-payment-status";

// #2262: the one status rule the per-row tx and the end-of-run sweep share.
describe("importPaymentStatus", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const past = new Date("2026-05-01T00:00:00Z");
  const inv = (status: InvoiceStatus, dueDate: Date | null = null) => ({
    status,
    total: 100,
    dueDate,
  });
  const paid = (amount: number, status = "PAID") => ({ amount, status });

  it("fully paid (within a tenth of a cent) ⇒ PAID, stamped now", () => {
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [paid(99.9995)], now)).toEqual({
      status: InvoiceStatus.PAID,
      paidAt: now,
    });
  });

  it("part paid ⇒ PARTIAL; unpaid past due ⇒ OVERDUE; otherwise unchanged (null)", () => {
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [paid(40)], now)).toEqual({
      status: InvoiceStatus.PARTIAL,
      paidAt: null,
    });
    expect(importPaymentStatus(inv(InvoiceStatus.SENT, past), [], now)).toEqual({
      status: InvoiceStatus.OVERDUE,
      paidAt: null,
    });
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [], now)).toBeNull();
    expect(importPaymentStatus(inv(InvoiceStatus.PARTIAL), [paid(40)], now)).toBeNull();
  });

  it("never flips DRAFT, VOID or WRITTEN_OFF", () => {
    for (const s of [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF])
      expect(importPaymentStatus(inv(s, past), [paid(100)], now)).toBeNull();
  });

  it("counts CONFIRMED (PAID) payments only — a DRAFT payment is not collected money", () => {
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [paid(100, "DRAFT")], now)).toBeNull();
  });
});
