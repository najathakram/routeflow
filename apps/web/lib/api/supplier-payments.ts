import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { roundMoney } from "@routeflow/pricing";
import type { SelectablePaymentMethod } from "../payment-methods";
import type { VendorBillStatus } from "./vendor-bills";
import type {
  RecordSupplierPaymentDto,
  RecordSupplierPaymentResult,
  SupplierStatement,
} from "@routeflow/types";
// X1: the payment DTO below is re-exported bare — its `TMethod` stays
// generic in `packages/types/api/finance.ts` on purpose. Do NOT bind that
// parameter with a same-named local alias in this file (the T1 sweep's "no
// local re-declaration in lib/api" guards — the shared-dto inventory spec and
// the shared-dto-rewrite codemod's `--check` — read this file's raw text and
// can't tell a narrowing alias apart from a forked duplicate). Bind the
// narrow union at each USE site instead: see `useRecordSupplierPayment`
// below and `RecordSupplierPaymentModal.tsx`, both of which apply the
// `SelectablePaymentMethod` type argument where they type the payload.
export type {
  RecordSupplierPaymentDto,
  RecordSupplierPaymentResult,
  SupplierAllocationLine,
  SupplierStatement,
  SupplierStatementRow,
  SupplierStatementRowType,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────
// PR-E WP4 — the AP mirror of `useRecordPaymentStandalone`/`StandalonePaymentDto`
// (lib/api/invoices.ts). Routes/shapes below are reconciled against WP2's
// actual controller/service (apps/api/src/vendor-bills/{vendor-bills.controller,
// vendor-bills.service}.ts): `POST /vendor-bills/payments/record` and
// `GET /vendor-bills/suppliers/:supplierId/statement` (both registered
// ahead of the `:id` routes in that controller).

/** Selectable "how was it paid" options — mirrors the AR modal's method
 *  select. CREDIT_NOTE/ADVANCE are payment EFFECTS (auto-apply of on-account
 *  credit), never an operator-chosen input. */
export type SupplierPaymentMethod = SelectablePaymentMethod;

export interface SupplierBillPaymentResult {
  id: string;
  vendorBillId: string;
  amount: number;
  method: string;
  reference?: string | null;
  notes?: string | null;
  paidAt?: string;
  paymentGroupId?: string | null;
}

/**
 * Record one lump-sum supplier payment across N bills — the AP mirror of
 * `useRecordPaymentStandalone`. A remainder beyond what's allocated becomes
 * on-account SupplierCredit server-side; it is never rejected here.
 */
export function useRecordSupplierPayment() {
  const qc = useQueryClient();
  return useMutation<
    RecordSupplierPaymentResult,
    Error,
    // X1: bind TMethod to web's enterable subset at the use site.
    RecordSupplierPaymentDto<SelectablePaymentMethod>
  >({
    mutationFn: (dto) => apiClient.post("/vendor-bills/payments/record", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["finance-dashboard"] });
    },
  });
}

// ─── Supplier statement (running balance) ──────────────────────────────────────
// Matches VendorBillsService.getSupplierStatement's actual return shape
// (reconciled against the WP2 implementation): a `timeline` array (NOT
// `rows`), each entry carrying `description` (NOT `label`) and a signed
// `amount` — a BILL increases what's owed (+), a PAYMENT/CREDIT decreases it
// (-) — with `balance` the running total after that entry. A SupplierCredit's
// draw-down against a bill is folded into that bill's own totalPaid and
// deliberately excluded from the timeline as its own row (it isn't new
// money), so PAYMENT rows here are real cash movements only.

export function useSupplierStatement(supplierId: string) {
  return useQuery<SupplierStatement>({
    queryKey: ["suppliers", supplierId, "statement"],
    queryFn: () =>
      apiClient.get(`/vendor-bills/suppliers/${supplierId}/statement`).then((r) => r.data),
    enabled: !!supplierId,
  });
}

// ─── Shared allocation-waterfall logic ─────────────────────────────────────────
// Mirrors apps/mobile/lib/payments-logic.ts's oldestInvoicesFirst /
// waterfallAllocations / allocationTotals, generalized over a bare {id,
// amountDue} shape so both RecordSupplierPaymentModal (bills) and
// CustomerRecordPaymentModal (invoices) share ONE implementation of the
// waterfall/clamp/remainder arithmetic instead of each re-deriving it —
// the actual "existing allocation logic" reuse the plan's WP4 calls for.
// Money discipline: every intermediate amount is roundMoney'd; the house
// epsilon is 0.001.

export interface AllocationTarget {
  id: string;
  amountDue: number;
}

export interface WaterfallAllocation {
  id: string;
  amount: number;
}

/**
 * Greedy waterfall pre-fill: fills `targets` in the order given (the caller
 * owns "oldest first" — sort before calling) up to `totalAmount`. Every
 * amount is cents-rounded and capped at each target's own amountDue, and the
 * running total never exceeds totalAmount. `excess` (paid − allocated)
 * becomes on-account credit server-side when > 0.001.
 */
export function waterfallAllocations(
  totalAmount: number,
  targets: AllocationTarget[],
): { allocations: WaterfallAllocation[]; allocated: number; excess: number } {
  let remaining = roundMoney(Math.max(0, totalAmount));
  const allocations: WaterfallAllocation[] = [];
  for (const t of targets) {
    if (remaining <= 0) break;
    const due = roundMoney(Math.max(0, t.amountDue));
    if (due <= 0) continue;
    const apply = roundMoney(Math.min(remaining, due));
    if (apply <= 0) continue;
    allocations.push({ id: t.id, amount: apply });
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
 * Totals for HAND-EDITED allocation rows (null = blank input). `overAllocated`
 * means the operator typed more than they paid/received — must block submit,
 * never silently truncate.
 */
export function allocationTotals(
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
