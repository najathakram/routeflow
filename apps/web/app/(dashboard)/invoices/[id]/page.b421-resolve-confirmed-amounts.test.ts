import { resolveConfirmedAmounts } from "./page";
import type { InvoicePayment } from "@/lib/api/invoices";

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

describe("resolveConfirmedAmounts (B421)", () => {
  const payments: InvoicePayment[] = [
    payment({ id: "p-cash", amount: 232, method: "CASH" }),
    payment({ id: "p-credit", amount: 638, method: "CREDIT_NOTE" }),
    payment({ id: "p-advance", amount: 100, method: "ADVANCE" }),
  ];

  it("prefers the server's paidAmount, defaulting missing creditApplied/advanceApplied to 0", () => {
    expect(resolveConfirmedAmounts({ paidAmount: 232 }, payments)).toEqual({
      amountPaid: 232,
      creditApplied: 0,
      advanceApplied: 0,
    });
  });

  it("uses the server's creditApplied/advanceApplied when given alongside paidAmount", () => {
    expect(
      resolveConfirmedAmounts(
        { paidAmount: 232, creditApplied: 638, advanceApplied: 100 },
        payments,
      ),
    ).toEqual({ amountPaid: 232, creditApplied: 638, advanceApplied: 100 });
  });

  it("REG-B421 hardening: never mixes an old credit-inclusive paidAmount with a freshly split credit/advance", () => {
    // A payload stuck on the pre-B421 shape sends the OLD full-inclusive sum
    // (232 + 638 + 100 = 970) and nothing else. Deriving creditApplied/
    // advanceApplied from `payments` here would double-subtract the 638 and
    // 100 already folded into that 970.
    expect(resolveConfirmedAmounts({ paidAmount: 970 }, payments)).toEqual({
      amountPaid: 970,
      creditApplied: 0,
      advanceApplied: 0,
    });
  });

  it("falls back to splitting payments for all three only when paidAmount is absent", () => {
    expect(resolveConfirmedAmounts({}, payments)).toEqual({
      amountPaid: 232,
      creditApplied: 638,
      advanceApplied: 100,
    });
  });

  it("the fallback split ignores DRAFT/VOID rows", () => {
    const mixed: InvoicePayment[] = [
      ...payments,
      payment({ id: "p-draft", amount: 999, method: "CASH", status: "DRAFT" }),
      payment({ id: "p-void", amount: 999, method: "CREDIT_NOTE", status: "VOID" }),
    ];
    expect(resolveConfirmedAmounts({}, mixed)).toEqual({
      amountPaid: 232,
      creditApplied: 638,
      advanceApplied: 100,
    });
  });
});
