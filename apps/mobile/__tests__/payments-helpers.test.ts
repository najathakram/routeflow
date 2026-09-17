/**
 * P10-PAR-4 pure-logic guards for the mobile payments parity screen. Locks the
 * method/status → pill+icon mapping and the void gating (void allowed unless
 * already VOID — matching the server contract so no shown action is rejected).
 */
import {
  allocationTotals,
  checkNextStates,
  editPaymentMaxAmount,
  oldestInvoicesFirst,
  paymentActionFlags,
  paymentMethodPill,
  paymentStatusPill,
  waterfallAllocations,
} from "../lib/payments-logic";
import type { PaymentMethod } from "../lib/api/invoices";
import type { PaymentStatus } from "../lib/api/payments";

describe("paymentMethodPill", () => {
  const cases: [PaymentMethod, string, string][] = [
    ["CASH", "green", "Cash"],
    ["CHECK", "brand", "Check"],
    ["ZELLE", "purple", "Zelle"],
    ["ACH", "purple", "ACH"],
    ["CREDIT_CARD", "orange", "Card"],
    ["CREDIT_NOTE", "purple", "Credit Note"],
    ["ADVANCE", "brand", "Advance"],
    ["OTHER", "gray", "Other"],
  ];
  it.each(cases)("%s → %s / %s", (method, variant, label) => {
    const p = paymentMethodPill(method);
    expect(p.variant).toBe(variant);
    expect(p.label).toBe(label);
    expect(typeof p.icon).toBe("string"); // valid Ionicon name
  });
});

describe("paymentStatusPill", () => {
  const cases: [PaymentStatus | undefined, string, string][] = [
    ["PAID", "green", "Paid"],
    ["DRAFT", "gray", "Draft"],
    ["VOID", "red", "Void"],
    [undefined, "green", "Paid"], // legacy rows default to Paid
  ];
  it.each(cases)("%s → %s / %s", (status, variant, label) => {
    expect(paymentStatusPill(status)).toEqual({ variant, label });
  });
});

describe("paymentActionFlags", () => {
  it.each(["PAID", "DRAFT", undefined] as (PaymentStatus | undefined)[])(
    "%s → can void",
    (status) => expect(paymentActionFlags(status)).toEqual({ canVoid: true }),
  );
  it("VOID → terminal, no void", () => {
    expect(paymentActionFlags("VOID")).toEqual({ canVoid: false });
  });
  it("CREDIT_NOTE method → no void (API refuses; matches web)", () => {
    expect(paymentActionFlags("PAID", "CREDIT_NOTE")).toEqual({ canVoid: false });
  });
  it.each(["ADVANCE", "CASH"] as PaymentMethod[])("%s method → voidable", (method) =>
    expect(paymentActionFlags("PAID", method)).toEqual({ canVoid: true }),
  );
});

describe("checkNextStates (Wave 3 — server CHECK_TRANSITIONS mirror)", () => {
  it("null stored status means RECORDED (server default): deposit or bounce", () => {
    expect(checkNextStates({ method: "CHECK", status: "PAID", checkStatus: null })).toEqual([
      "DEPOSITED",
      "BOUNCED",
    ]);
    expect(checkNextStates({ method: "CHECK", status: "PAID" })).toEqual(["DEPOSITED", "BOUNCED"]);
  });

  it("DEPOSITED → clear or bounce; CLEARED can still bounce; BOUNCED is terminal", () => {
    expect(checkNextStates({ method: "CHECK", checkStatus: "DEPOSITED" })).toEqual([
      "CLEARED",
      "BOUNCED",
    ]);
    expect(checkNextStates({ method: "CHECK", checkStatus: "CLEARED" })).toEqual(["BOUNCED"]);
    expect(checkNextStates({ method: "CHECK", checkStatus: "BOUNCED" })).toEqual([]);
  });

  it("non-checks and voided rows offer nothing (server 400s both)", () => {
    expect(checkNextStates({ method: "CASH" })).toEqual([]);
    expect(checkNextStates({ method: "CHECK", status: "VOID", checkStatus: "RECORDED" })).toEqual(
      [],
    );
  });
});

describe("waterfallAllocations (Wave 3 — client owns ALL the safety the server lacks)", () => {
  const inv = (id: string, balanceDue: number) => ({ id, balanceDue });

  it("greedy fill in array order, capped at each balance", () => {
    const r = waterfallAllocations(100, [inv("a", 40), inv("b", 35), inv("c", 50)]);
    expect(r.allocations).toEqual([
      { invoiceId: "a", amount: 40 },
      { invoiceId: "b", amount: 35 },
      { invoiceId: "c", amount: 25 },
    ]);
    expect(r.allocated).toBe(100);
    expect(r.excess).toBe(0);
  });

  it("excess (received − allocated) is what becomes an advance", () => {
    const r = waterfallAllocations(100, [inv("a", 60.5)]);
    expect(r.allocations).toEqual([{ invoiceId: "a", amount: 60.5 }]);
    expect(r.excess).toBe(39.5);
  });

  it("cents-rounds everything — the server applies allocations verbatim", () => {
    // 0.1 + 0.2 style float dirt must never reach the wire.
    const r = waterfallAllocations(0.3, [inv("a", 0.1), inv("b", 0.2), inv("c", 10)]);
    expect(r.allocations).toEqual([
      { invoiceId: "a", amount: 0.1 },
      { invoiceId: "b", amount: 0.2 },
    ]);
    expect(r.allocated).toBe(0.3);
    expect(r.excess).toBe(0);
  });

  it("skips zero/negative balances and never over-allocates", () => {
    const r = waterfallAllocations(50, [inv("a", 0), inv("b", -5), inv("c", 20)]);
    expect(r.allocations).toEqual([{ invoiceId: "c", amount: 20 }]);
    expect(r.excess).toBe(30);
  });

  it("zero/negative received allocates nothing", () => {
    expect(waterfallAllocations(0, [inv("a", 10)]).allocations).toEqual([]);
    expect(waterfallAllocations(-5, [inv("a", 10)]).allocations).toEqual([]);
  });
});

describe("allocationTotals (hand-edited rows)", () => {
  it("flags over-allocation — the server would silently accept it", () => {
    const r = allocationTotals(50, [{ amount: 30 }, { amount: 25 }]);
    expect(r.allocated).toBe(55);
    expect(r.overAllocated).toBe(true);
    expect(r.excess).toBe(0);
  });

  it("blank rows count as zero; exact fill is not over-allocated", () => {
    const r = allocationTotals(50, [{ amount: 30 }, { amount: null }, { amount: 20 }]);
    expect(r).toEqual({ allocated: 50, excess: 0, overAllocated: false });
  });

  it("under-allocation reports the advance-bound excess", () => {
    expect(allocationTotals(100, [{ amount: 60.25 }]).excess).toBe(39.75);
  });
});

describe("oldestInvoicesFirst", () => {
  it("sorts by issueDate, falling back to createdAt, ascending", () => {
    const rows = [
      { id: "new", issueDate: "2026-08-01", createdAt: "2026-08-01" },
      { id: "old", issueDate: "2026-06-15", createdAt: "2026-06-15" },
      { id: "noIssue", issueDate: null, createdAt: "2026-07-01" },
    ];
    expect(oldestInvoicesFirst(rows).map((r: any) => r.id)).toEqual(["old", "noIssue", "new"]);
  });

  it("does not mutate the input", () => {
    const rows = [{ issueDate: "2026-08-01" }, { issueDate: "2026-06-01" }];
    oldestInvoicesFirst(rows);
    expect(rows[0].issueDate).toBe("2026-08-01");
  });
});

// PR-2 (check-payments B1 hardening): editPaymentMaxAmount routes through the
// shared remainingCapacity() predicate (DRAFT+PAID+PENDING all reserve
// capacity) — this locks the mobile edit-payment cap to the same semantics
// the server (updatePayment) and web (editPaymentMax) now use.
describe("editPaymentMaxAmount", () => {
  it("reserves a DRAFT sibling's capacity, not just PAID ones", () => {
    // total 100, siblings: $30 DRAFT + $10 PAID -> capacity 60.
    const max = editPaymentMaxAmount(100, [
      { amount: 30, status: "DRAFT" },
      { amount: 10, status: "PAID" },
    ]);
    expect(max).toBe(60);
  });

  it("ignores a VOID sibling entirely", () => {
    const max = editPaymentMaxAmount(100, [{ amount: 999, status: "VOID" }]);
    expect(max).toBe(100);
  });

  it("floors at 0 rather than going negative when siblings already exceed the total", () => {
    const max = editPaymentMaxAmount(100, [{ amount: 150, status: "PAID" }]);
    expect(max).toBe(0);
  });

  it("returns the full total with no siblings", () => {
    expect(editPaymentMaxAmount(250, [])).toBe(250);
  });
});
