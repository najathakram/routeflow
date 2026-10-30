import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/api/src/payment-requests return shapes) ─────────────────

export type PaymentRequestKind = "CARD" | "CASH";

export type PaymentRequestStatus =
  "PENDING" | "APPROVED" | "REJECTED" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface AllocationPreviewLine {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  total: number;
  balanceDue: number;
  applied: number;
}

export interface PaymentRequest {
  id: string;
  kind: PaymentRequestKind;
  status: PaymentRequestStatus;
  amount: number;
  note: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  contactName: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  /** Only present on PENDING rows — where the money would land if approved. */
  allocationPreview?: AllocationPreviewLine[];
}

export interface ApprovePaymentRequestResult {
  approved: boolean;
  paymentGroupId: string;
  excess: number;
}

const KEY = ["payment-requests"] as const;

// ─── Queries ────────────────────────────────────────────────────────────────

export function usePaymentRequests(status?: string) {
  return useQuery<PaymentRequest[]>({
    queryKey: [...KEY, status ?? "all"],
    queryFn: () =>
      apiClient
        .get("/payment-requests", { params: status ? { status } : undefined })
        .then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Approve/reject write money or free up the row — refresh the queue plus
 *  whatever balances they can move: invoices and customer account summaries. */
function useDecisionMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  localErrorToast?: boolean | ((error: unknown) => boolean),
) {
  const qc = useQueryClient();
  return useMutation<TResult, Error, TVars>({
    mutationFn: fn,
    meta: localErrorToast ? { localErrorToast } : undefined,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useApprovePaymentRequest() {
  return useDecisionMutation<
    string | { id: string; recordAnyway?: boolean },
    ApprovePaymentRequestResult
  >(
    (vars) => {
      const { id, recordAnyway } =
        typeof vars === "string" ? { id: vars, recordAnyway: false } : vars;
      // SA-837b item 2: the approving staff member's "Record anyway" resend of a duplicate payment reference.
      return apiClient
        .post(`/payment-requests/${id}/approve`, recordAnyway ? { recordAnyway: true } : undefined)
        .then((r) => r.data);
    },
    // Rows 348 / 353: the page renders every approve failure itself (a closed day, a duplicate reference's "Record
    // anyway", anything else), so the global toast stays quiet for all of them.
    true,
  );
}

export function useRejectPaymentRequest() {
  return useDecisionMutation<{ id: string; reason?: string }, { rejected: boolean }>(
    ({ id, reason }) =>
      apiClient.post(`/payment-requests/${id}/reject`, { reason }).then((r) => r.data),
    true, // row 353: the page toasts a failed reject itself
  );
}
