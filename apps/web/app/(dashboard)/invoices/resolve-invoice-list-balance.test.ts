import { resolveInvoiceListBalance } from "./page";
import type { Invoice, InvoicePayment } from "@/lib/api/invoices";

function payment(overrides: Partial<InvoicePayment>): InvoicePayment {
  return {
    id: "pay-1",
    amount: 0,
    method: "CASH",
    status: "PAID",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as InvoicePayment;
}

function invoice(
  overrides: Partial<Invoice>,
): Pick<
  Invoice,
  "total" | "balanceDue" | "paidAmount" | "creditApplied" | "advanceApplied" | "payments"
> {
  return { total: 870, payments: [], ...overrides };
}

describe("resolveInvoiceListBalance (B421)", () => {
  it("REG-B421 (worst instance): a credit-note application no longer collapses the balance to 0", () => {
    // Before the fix, `paid` summed EVERY payment row with no status or
    // method filter at all -- a $638 CREDIT_NOTE row alone made an $870
    // invoice look fully paid off. It should still owe $232.
    const inv = invoice({
      payments: [payment({ amount: 638, method: "CREDIT_NOTE" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(232);
  });

  it("REG-B421: an ADVANCE application reduces the balance the same way, never counted as cash", () => {
    const inv = invoice({
      payments: [payment({ amount: 100, method: "ADVANCE" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(770);
  });

  it("REG-B421: a DRAFT payment is never counted toward the balance (the old bug had no status filter)", () => {
    const inv = invoice({
      payments: [payment({ amount: 500, method: "CASH", status: "DRAFT" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(870);
  });

  it("REG-B421: a VOID payment is never counted toward the balance", () => {
    const inv = invoice({
      payments: [payment({ amount: 500, method: "CASH", status: "VOID" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(870);
  });

  it("prefers the server's own balanceDue when present, ignoring payments entirely", () => {
    const inv = invoice({
      balanceDue: 50,
      payments: [payment({ amount: 999999, method: "CASH" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(50);
  });

  it("a real cash payment still reduces the balance normally", () => {
    const inv = invoice({
      payments: [payment({ amount: 232, method: "CASH" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(638);
  });

  it("never goes negative", () => {
    const inv = invoice({
      total: 100,
      payments: [payment({ amount: 150, method: "CASH" })],
    });
    expect(resolveInvoiceListBalance(inv)).toBe(0);
  });
});
