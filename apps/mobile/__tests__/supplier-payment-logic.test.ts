/**
 * PR-E WP6 — pure-logic guards for the mobile supplier payment allocation
 * sheet, the AP mirror of `payments-helpers.test.ts`'s AR coverage. Locks the
 * waterfall order, per-row clamping, remainder computation, and — the
 * landmine this PR exists to guard against — that eligibility is arithmetic
 * (`totalOwed − totalPaid > 0.001`), never `VendorBillStatus`.
 */
import {
  billAllocationTotals,
  billBalance,
  eligibleBills,
  oldestBillsFirst,
  waterfallBillAllocations,
} from "../lib/supplier-payment-logic";

describe("billBalance", () => {
  it("is totalOwed minus totalPaid, never negative", () => {
    expect(billBalance({ totalOwed: 100, totalPaid: 40 })).toBe(60);
    expect(billBalance({ totalOwed: 100, totalPaid: 150 })).toBe(0);
  });

  it("treats missing fields as zero", () => {
    expect(billBalance({})).toBe(0);
    expect(billBalance({ totalOwed: 50 })).toBe(50);
  });
});

describe("eligibleBills (landmine: VendorBillStatus.PARTIAL is overloaded)", () => {
  it("a short-received PARTIAL bill with totalPaid = 0 is fully allocatable", () => {
    // receive() writes PARTIAL for a SHORT RECEIPT, unrelated to payment —
    // eligibility must read the arithmetic, not the status label.
    const bill = { id: "b1", status: "PARTIAL", totalOwed: 200, totalPaid: 0 };
    const result = eligibleBills([bill]);
    expect(result).toEqual([bill]);
  });

  it("a part-paid PARTIAL bill is eligible for its remaining balance only", () => {
    const bill = { id: "b1", status: "PARTIAL", totalOwed: 200, totalPaid: 120 };
    expect(eligibleBills([bill])).toEqual([bill]);
    expect(billBalance(bill)).toBe(80);
  });

  it("excludes VOID bills regardless of arithmetic balance", () => {
    const bill = { id: "b1", status: "VOID", totalOwed: 200, totalPaid: 0 };
    expect(eligibleBills([bill])).toEqual([]);
  });

  it("excludes a fully paid bill (balance within epsilon of zero)", () => {
    const paid = { id: "b1", status: "PAID", totalOwed: 100, totalPaid: 100 };
    const dust = { id: "b2", status: "PAID", totalOwed: 100, totalPaid: 99.9995 };
    expect(eligibleBills([paid, dust])).toEqual([]);
  });

  it("a RECEIVED bill with no payments is eligible for its whole totalOwed", () => {
    const bill = { id: "b1", status: "RECEIVED", totalOwed: 75, totalPaid: 0 };
    expect(eligibleBills([bill])).toEqual([bill]);
  });
});

describe("oldestBillsFirst", () => {
  it("sorts by billDate, falling back to createdAt, ascending", () => {
    const bills = [
      { id: "new", billDate: "2026-08-01", createdAt: "2026-08-01" },
      { id: "old", billDate: "2026-06-15", createdAt: "2026-06-15" },
      { id: "noDate", billDate: null, createdAt: "2026-07-01" },
    ];
    expect(oldestBillsFirst(bills).map((b) => b.id)).toEqual(["old", "noDate", "new"]);
  });

  it("does not mutate the input", () => {
    const bills = [
      { id: "a", billDate: "2026-08-01" },
      { id: "b", billDate: "2026-06-01" },
    ];
    oldestBillsFirst(bills);
    expect(bills[0].id).toBe("a");
  });
});

describe("waterfallBillAllocations (client owns ALL the safety the server lacks)", () => {
  const bill = (id: string, balance: number) => ({ id, balance });

  it("greedy fill in array order, capped at each bill's balance", () => {
    const r = waterfallBillAllocations(100, [bill("a", 40), bill("b", 35), bill("c", 50)]);
    expect(r.allocations).toEqual([
      { vendorBillId: "a", amount: 40 },
      { vendorBillId: "b", amount: 35 },
      { vendorBillId: "c", amount: 25 },
    ]);
    expect(r.allocated).toBe(100);
    expect(r.excess).toBe(0);
  });

  it("excess (paid − allocated) is what becomes a SupplierCredit", () => {
    const r = waterfallBillAllocations(100, [bill("a", 60.5)]);
    expect(r.allocations).toEqual([{ vendorBillId: "a", amount: 60.5 }]);
    expect(r.excess).toBe(39.5);
  });

  it("cents-rounds everything — the server applies allocations verbatim", () => {
    const r = waterfallBillAllocations(0.3, [bill("a", 0.1), bill("b", 0.2), bill("c", 10)]);
    expect(r.allocations).toEqual([
      { vendorBillId: "a", amount: 0.1 },
      { vendorBillId: "b", amount: 0.2 },
    ]);
    expect(r.allocated).toBe(0.3);
    expect(r.excess).toBe(0);
  });

  it("skips zero/negative balances and never over-allocates", () => {
    const r = waterfallBillAllocations(50, [bill("a", 0), bill("b", -5), bill("c", 20)]);
    expect(r.allocations).toEqual([{ vendorBillId: "c", amount: 20 }]);
    expect(r.excess).toBe(30);
  });

  it("zero/negative paid allocates nothing", () => {
    expect(waterfallBillAllocations(0, [bill("a", 10)]).allocations).toEqual([]);
    expect(waterfallBillAllocations(-5, [bill("a", 10)]).allocations).toEqual([]);
  });

  it("a whole payment can go to a single short-received PARTIAL bill's full totalOwed", () => {
    // End-to-end of the landmine: eligibleBills lets it through, the
    // waterfall allocates its entire balance (== totalOwed, since totalPaid
    // was 0), not some status-derived partial amount.
    const shortReceived = { id: "b1", status: "PARTIAL", totalOwed: 200, totalPaid: 0 };
    const eligible = eligibleBills([shortReceived]);
    const r = waterfallBillAllocations(
      200,
      eligible.map((b) => ({ id: b.id, balance: billBalance(b) })),
    );
    expect(r.allocations).toEqual([{ vendorBillId: "b1", amount: 200 }]);
    expect(r.excess).toBe(0);
  });
});

describe("billAllocationTotals (hand-edited rows)", () => {
  it("flags over-allocation — the server would silently accept it", () => {
    const r = billAllocationTotals(50, [{ amount: 30 }, { amount: 25 }]);
    expect(r.allocated).toBe(55);
    expect(r.overAllocated).toBe(true);
    expect(r.excess).toBe(0);
  });

  it("blank rows count as zero; exact fill is not over-allocated", () => {
    const r = billAllocationTotals(50, [{ amount: 30 }, { amount: null }, { amount: 20 }]);
    expect(r).toEqual({ allocated: 50, excess: 0, overAllocated: false });
  });

  it("under-allocation reports the account-credit-bound remainder", () => {
    expect(billAllocationTotals(100, [{ amount: 60.25 }]).excess).toBe(39.75);
  });
});
