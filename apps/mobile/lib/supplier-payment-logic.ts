import { roundMoney } from "@routeflow/pricing";

/**
 * Pure AP allocation helpers — the payable mirror of `lib/payments-logic.ts`'s
 * AR waterfall (`oldestInvoicesFirst` / `waterfallAllocations` /
 * `allocationTotals`). Same shape, same client-side safety story:
 * `POST /vendor-bills/payments/record` applies allocations VERBATIM (no
 * rounding, no per-bill cap, no sum≤total guard, mirroring the AR standalone
 * endpoint), so every safety property lives HERE — cents-rounded amounts,
 * capped at each bill's remaining balance, and the running total never
 * exceeds totalAmount.
 *
 * Eligibility landmine (PR-E): `VendorBillStatus.PARTIAL` is overloaded — it
 * is written both for a SHORT RECEIPT (`receive()`) and a PART PAYMENT
 * (`recordPayment`). Eligibility must therefore be computed as
 * `totalOwed − totalPaid > 0.001`, NEVER from status. A short-received
 * PARTIAL bill with `totalPaid = 0` is fully payable for its whole
 * `totalOwed`. Kept out of the RN screens so __tests__/*.test.ts (node env)
 * can lock it.
 */

export interface AllocatableBill {
  id: string;
  status?: string | null;
  totalOwed?: number | null;
  totalPaid?: number | null;
  billDate?: string | null;
  createdAt?: string | null;
}

export interface BillAllocationRow {
  vendorBillId: string;
  amount: number;
}

/** Remaining balance owed on a bill — pure arithmetic, never status. */
export function billBalance(bill: {
  totalOwed?: number | null;
  totalPaid?: number | null;
}): number {
  const owed = roundMoney(Number(bill.totalOwed ?? 0));
  const paid = roundMoney(Number(bill.totalPaid ?? 0));
  return roundMoney(Math.max(0, owed - paid));
}

/**
 * Bills with a real outstanding balance. VOID is excluded explicitly (mirrors
 * `getSupplierStatement`'s "non-VOID bills" outstanding sum) — everything
 * else (RECEIVED/PARTIAL/PAID/DRAFT) is judged purely by `billBalance`, never
 * by status, so a short-received PARTIAL bill with no payments yet is fully
 * eligible for its whole `totalOwed`.
 */
export function eligibleBills<T extends AllocatableBill>(bills: T[]): T[] {
  return bills.filter((b) => b.status !== "VOID" && billBalance(b) > 0.001);
}

/**
 * Oldest bills first for the allocation waterfall: earliest `billDate` (falls
 * back to `createdAt`) wins. The server applies allocations in ARRAY ORDER
 * and does no selection of its own, so the client owns "oldest-first".
 */
export function oldestBillsFirst<T extends AllocatableBill>(bills: T[]): T[] {
  return [...bills].sort((a, b) =>
    (a.billDate ?? a.createdAt ?? "").localeCompare(b.billDate ?? b.createdAt ?? ""),
  );
}

/**
 * Greedy waterfall pre-fill for `POST /vendor-bills/payments/record`. Mirrors
 * `waterfallAllocations` exactly: cents-rounded amounts, capped at each
 * bill's remaining `balance`, running total never exceeds `totalAmount`.
 * `excess` (paid − allocated) becomes a `SupplierCredit` server-side when
 * > 0.001.
 */
export function waterfallBillAllocations(
  totalAmount: number,
  bills: Array<{ id: string; balance: number }>,
): { allocations: BillAllocationRow[]; allocated: number; excess: number } {
  let remaining = roundMoney(Math.max(0, totalAmount));
  const allocations: BillAllocationRow[] = [];
  for (const bill of bills) {
    if (remaining <= 0) break;
    const due = roundMoney(Math.max(0, bill.balance));
    if (due <= 0) continue;
    const apply = roundMoney(Math.min(remaining, due));
    if (apply <= 0) continue;
    allocations.push({ vendorBillId: bill.id, amount: apply });
    remaining = roundMoney(remaining - apply);
  }
  const allocated = roundMoney(allocations.reduce((s, a) => s + a.amount, 0));
  return {
    allocations,
    allocated,
    excess: roundMoney(Math.max(0, roundMoney(totalAmount) - allocated)),
  };
}

/**
 * Totals for HAND-EDITED allocation rows (null = blank input).
 * `overAllocated` means the operator typed more than they paid — the server
 * would silently accept it and record no credit, so the sheet must block
 * submit on it. Mirrors `allocationTotals`.
 */
export function billAllocationTotals(
  totalAmount: number,
  rows: Array<{ amount: number | null }>,
): { allocated: number; excess: number; overAllocated: boolean } {
  const allocated = roundMoney(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
  const total = roundMoney(totalAmount);
  return {
    allocated,
    excess: roundMoney(Math.max(0, total - allocated)),
    overAllocated: allocated > total + 0.001,
  };
}
