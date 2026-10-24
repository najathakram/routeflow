import { InvoiceStatus } from "@prisma/client";
import { overpaidByOf, statusFromPayments } from "./invoice-status";

/**
 * SA-763r P-3 [L-O1] / [L-O2] (B1098): the ONE status-from-payments body. An overpaid invoice is never
 * PAID unless the caller deliberately says so (`onOverpaid: "PAID"`, the operator's standalone
 * overpayment only).
 */
describe("statusFromPayments", () => {
  const PAST = new Date("2026-01-01T00:00:00Z");
  const FUTURE = new Date("2099-01-01T00:00:00Z");
  const NOW = new Date("2026-06-01T12:00:00Z");
  const S = (
    paid: number,
    total: number,
    due: Date | null,
    cur: InvoiceStatus | undefined,
    onOverpaid: "NOT_PAID" | "PAID" = "NOT_PAID",
  ) => statusFromPayments(paid, total, due, cur, "UTC", onOverpaid, NOW);

  describe("the unchanged branches", () => {
    it("fully paid -> PAID, part paid -> PARTIAL, unpaid -> SENT / OVERDUE by the due day", () => {
      expect(S(100, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.PAID);
      expect(S(99.9995, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.PAID); // 0.001 tolerance
      expect(S(40, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.PARTIAL);
      expect(S(0, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.SENT);
      expect(S(0, 100, PAST, InvoiceStatus.SENT)).toBe(InvoiceStatus.OVERDUE);
    });

    it("DRAFT, VOID and WRITTEN_OFF are terminal at any payment", () => {
      for (const st of [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF]) {
        expect(S(0, 100, PAST, st)).toBe(st);
        expect(S(130, 100, PAST, st)).toBe(st);
        expect(S(130, 100, PAST, st, "PAID")).toBe(st);
      }
    });
  });

  describe("overpaid (paid > total + 0.005), onOverpaid NOT_PAID", () => {
    it("is SENT before the due day, OVERDUE once it has ended", () => {
      expect(S(130, 100, FUTURE, InvoiceStatus.PAID)).toBe(InvoiceStatus.SENT);
      expect(S(130, 100, PAST, InvoiceStatus.PAID)).toBe(InvoiceStatus.OVERDUE);
      expect(S(130, 100, null, InvoiceStatus.PAID)).toBe(InvoiceStatus.SENT); // no due date: not past due
    });

    it("VIEWED falls back to SENT, a prior PARTIAL / OVERDUE is recomputed, never kept as PAID", () => {
      expect(S(130, 100, FUTURE, InvoiceStatus.VIEWED)).toBe(InvoiceStatus.SENT);
      expect(S(130, 100, FUTURE, InvoiceStatus.PARTIAL)).toBe(InvoiceStatus.SENT);
      expect(S(130, 100, FUTURE, undefined)).toBe(InvoiceStatus.SENT);
    });

    it("exactly paid, or within the half-cent tolerance, is still PAID (not an overpayment)", () => {
      expect(S(100.005, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.PAID);
      expect(S(100.0051, 100, FUTURE, InvoiceStatus.SENT)).toBe(InvoiceStatus.SENT);
    });
  });

  describe("overpaid, onOverpaid PAID (the deliberate standalone overpayment)", () => {
    it("stays PAID", () => {
      expect(S(105, 100, FUTURE, InvoiceStatus.SENT, "PAID")).toBe(InvoiceStatus.PAID);
      expect(S(105, 100, PAST, InvoiceStatus.OVERDUE, "PAID")).toBe(InvoiceStatus.PAID);
    });

    it("does not change a non-overpaid result", () => {
      expect(S(40, 100, FUTURE, InvoiceStatus.SENT, "PAID")).toBe(InvoiceStatus.PARTIAL);
      expect(S(100, 100, FUTURE, InvoiceStatus.SENT, "PAID")).toBe(InvoiceStatus.PAID);
    });
  });

  describe("overpaidByOf: the derived response field", () => {
    it("is max(0, externalPaid - total), cents-rounded", () => {
      expect(overpaidByOf(100, 130)).toBe(30);
      expect(overpaidByOf(100, 100)).toBe(0);
      expect(overpaidByOf(100, 40)).toBe(0);
      expect(overpaidByOf("100.10", 130.3)).toBe(30.2);
      expect(overpaidByOf(100, 100.004)).toBe(0); // under the half-cent tolerance
    });
  });
});
