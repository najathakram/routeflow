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
function useDecisionMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation<TResult, Error, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useApprovePaymentRequest() {
  return useDecisionMutation<string, ApprovePaymentRequestResult>((id) =>
    apiClient.post(`/payment-requests/${id}/approve`).then((r) => r.data),
  );
}

export function useRejectPaymentRequest() {
  return useDecisionMutation<{ id: string; reason?: string }, { rejected: boolean }>(
    ({ id, reason }) =>
      apiClient.post(`/payment-requests/${id}/reject`, { reason }).then((r) => r.data),
  );
}
