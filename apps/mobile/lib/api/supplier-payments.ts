import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { EditablePaymentMethod } from "./payments";

/**
 * PR-E WP6 — supplier-level payment allocation, the AP mirror of
 * `lib/api/payments.ts`'s AR standalone-payment surface
 * (`useRecordPaymentStandalone` / `POST /invoices/payments/record`). Hits
 * `apps/api/src/vendor-bills/vendor-bills.service.ts`'s
 * `recordSupplierPayment` / `getSupplierStatement` (PR-E WP2), exposed via
 * `vendor-bills.controller.ts` mirroring the existing single-bill
 * `POST /vendor-bills/:id/payments` route family.
 */

// ─── Record a supplier payment (multi-bill allocation) ───────────────────────

export interface SupplierAllocationRow {
  vendorBillId: string;
  /** Cents-rounded CLIENT-side (`lib/supplier-payment-logic.ts`) so the sheet's
   *  arithmetic matches the server's. Unlike the AR standalone endpoint, the
   *  server DOES re-round and validate here: it rejects an allocation to
   *  another supplier's bill, one exceeding that bill's remaining balance, or
   *  a set summing past `totalAmount`. */
  amount: number;
}

export interface RecordSupplierPaymentDto {
  supplierId: string;
  /** Cash actually paid out. Anything not covered by `allocations`
   *  (> 0.001) becomes a `SupplierCredit` for the supplier, server-side. */
  totalAmount: number;
  /** Hand-enterable methods only — mirrors the AR DTO's `EditablePaymentMethod`. */
  method: EditablePaymentMethod;
  paidAt?: string;
  reference?: string;
  notes?: string;
  allocations: SupplierAllocationRow[];
}

export interface SupplierBillPayment {
  id: string;
  vendorBillId: string;
  amount: number;
  method: string;
  reference?: string | null;
  notes?: string | null;
  paymentGroupId?: string | null;
  createdAt: string;
}

export interface RecordSupplierPaymentResult {
  paymentGroupId: string;
  payments: SupplierBillPayment[];
  /** Unallocated remainder — becomes a `SupplierCredit`, never rejected. */
  excess: number;
  bills: { id: string; status: string; totalPaid: number }[];
}

/**
 * One payment across several bills — `POST /vendor-bills/payments/record`.
 * Returns every created `BillPayment` row (sharing one `paymentGroupId`) +
 * the unallocated excess, which becomes account credit. The server enforces
 * the per-bill cap, the supplier-ownership check and `Σ allocations ≤
 * totalAmount` (400 + full rollback on any of them); the sheet still clamps
 * client-side (`lib/supplier-payment-logic.ts` waterfall/totals) so the
 * operator sees the problem before submitting rather than as a 400.
 */
export function useRecordSupplierPayment() {
  const qc = useQueryClient();
  return useMutation<RecordSupplierPaymentResult, Error, RecordSupplierPaymentDto>({
    mutationFn: (dto) => apiClient.post("/vendor-bills/payments/record", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["finance-dashboard"] });
    },
  });
}

// ─── Supplier statement (running balance) ─────────────────────────────────────

export type SupplierStatementRowType = "BILL" | "PAYMENT" | "CREDIT";

/** One line of the running-balance timeline. Mirrors what
 *  `VendorBillsService.getSupplierStatement` actually returns: the array is
 *  `timeline` (not `rows`), the caption is `description` (not `label`), and
 *  `amount` is SIGNED — a BILL is positive, a PAYMENT/CREDIT negative. A
 *  credit's draw-down against a bill is folded into that bill's `totalPaid`
 *  and deliberately omitted as its own row (it is not new money), so PAYMENT
 *  rows are real cash movements only. */
export interface SupplierStatementRow {
  id: string;
  type: SupplierStatementRowType;
  date: string;
  description: string;
  billId?: string;
  billNumber?: string;
  paymentGroupId?: string | null;
  /** Signed: BILL increases what's owed (+); PAYMENT/CREDIT decreases it (−). */
  amount: number;
  /** Running balance AFTER this row is applied. */
  balance: number;
}

export interface SupplierStatement {
  supplierId: string;
  timeline: SupplierStatementRow[];
  totalOwed: number;
  totalPaid: number;
  /** Σ(totalOwed − totalPaid) over non-VOID bills — arithmetic, never status. */
  outstanding: number;
  /** Current `SupplierCredit.balance` sum available to draw down. */
  creditBalance: number;
}

/**
 * Running-balance timeline for one supplier —
 * `GET /vendor-bills/suppliers/:supplierId/statement`
 * (`vendor-bills.service.ts#getSupplierStatement`). A pure read: bills (up)
 * and payments/credits (down) merged and sorted by date, each row carrying a
 * running balance.
 */
export function useSupplierStatement(supplierId: string) {
  return useQuery<SupplierStatement>({
    queryKey: ["suppliers", supplierId, "statement"],
    queryFn: () =>
      apiClient.get(`/vendor-bills/suppliers/${supplierId}/statement`).then((r) => r.data),
    enabled: !!supplierId,
    staleTime: 30_000,
  });
}
