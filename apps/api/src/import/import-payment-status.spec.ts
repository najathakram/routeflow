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
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [paid(99.9995)], now, null)).toEqual({
      status: InvoiceStatus.PAID,
      paidAt: now,
    });
  });

  it("part paid ⇒ PARTIAL; unpaid past due ⇒ OVERDUE; otherwise unchanged (null)", () => {
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [paid(40)], now, null)).toEqual({
      status: InvoiceStatus.PARTIAL,
      paidAt: null,
    });
    expect(importPaymentStatus(inv(InvoiceStatus.SENT, past), [], now, null)).toEqual({
      status: InvoiceStatus.OVERDUE,
      paidAt: null,
    });
    expect(importPaymentStatus(inv(InvoiceStatus.SENT), [], now, null)).toBeNull();
    expect(importPaymentStatus(inv(InvoiceStatus.PARTIAL), [paid(40)], now, null)).toBeNull();
  });

  it("never flips DRAFT, VOID or WRITTEN_OFF", () => {
    for (const s of [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF])
      expect(importPaymentStatus(inv(s, past), [paid(100)], now, null)).toBeNull();
  });

  it("counts CONFIRMED (PAID) payments only — a DRAFT payment is not collected money", () => {
    expect(
      importPaymentStatus(inv(InvoiceStatus.SENT), [paid(100, "DRAFT")], now, null),
    ).toBeNull();
  });

  describe("SA-964 §3: OVERDUE waits for the due day to END in the tenant's zone", () => {
    // Chicago invoice due 2026-10-25 (stored 00:00Z): the due day ends at 05:00Z on the 26th (CDT).
    const due = new Date("2026-10-25T00:00:00Z");
    const CHI = "America/Chicago";

    it("at 03:00Z on the 26th (22:00 CDT on the due day) it is NOT yet overdue", () => {
      expect(
        importPaymentStatus(
          inv(InvoiceStatus.SENT, due),
          [],
          new Date("2026-10-26T03:00:00Z"),
          CHI,
        ),
      ).toBeNull();
    });

    it("at 05:00Z on the 26th (the due day ended in Chicago) it is OVERDUE", () => {
      expect(
        importPaymentStatus(
          inv(InvoiceStatus.SENT, due),
          [],
          new Date("2026-10-26T05:00:00Z"),
          CHI,
        ),
      ).toEqual({ status: InvoiceStatus.OVERDUE, paidAt: null });
    });

    it("control: with no zone (UTC) the same 03:00Z instant IS overdue, as master wrote it", () => {
      expect(
        importPaymentStatus(
          inv(InvoiceStatus.SENT, due),
          [],
          new Date("2026-10-26T03:00:00Z"),
          null,
        ),
      ).toEqual({ status: InvoiceStatus.OVERDUE, paidAt: null });
    });
  });
});
