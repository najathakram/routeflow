import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { EditablePaymentMethod } from "./payments";
import type {
  RecordSupplierPaymentDto,
  RecordSupplierPaymentResult,
  SupplierAllocationLine,
  SupplierStatement,
} from "@routeflow/types";
// X1: the payment DTO below is re-exported bare — its `TMethod` stays
// generic in `packages/types/api/finance.ts` on purpose. Do NOT bind that
// parameter with a same-named local alias in this file (the T1 sweep's "no
// local re-declaration in lib/api" guards — the shared-dto inventory spec and
// the shared-dto-rewrite codemod's `--check` — read this file's raw text and
// can't tell a narrowing alias apart from a forked duplicate). Bind the
// narrow union at each USE site instead: see `useRecordSupplierPayment`
// below, which applies the `EditablePaymentMethod` type argument where it
// types the mutation payload.
export type {
  RecordSupplierPaymentDto,
  RecordSupplierPaymentResult,
  SupplierStatement,
  SupplierStatementRow,
  SupplierStatementRowType,
} from "@routeflow/types";

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

/**
 * Wave E / imp-10b R2: identical to web's `SupplierAllocationLine` — imported
 * (aliased to this file's historical local name) rather than redeclared.
 * Cents-rounded CLIENT-side (`lib/supplier-payment-logic.ts`) so the sheet's
 * arithmetic matches the server's. Unlike the AR standalone endpoint, the
 * server DOES re-round and validate here: it rejects an allocation to another
 * supplier's bill, one exceeding that bill's remaining balance, or a set
 * summing past `totalAmount`.
 */
export type SupplierAllocationRow = SupplierAllocationLine;

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
  return useMutation<
    RecordSupplierPaymentResult,
    Error,
    // X1: bind TMethod to mobile's enterable subset at the use site.
    RecordSupplierPaymentDto<EditablePaymentMethod>
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

// ─── Supplier statement (running balance) ─────────────────────────────────────

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
