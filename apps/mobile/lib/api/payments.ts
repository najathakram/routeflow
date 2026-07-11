import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { PaymentMethod } from "./invoices"; // reuse the existing 7-value union

// ─── Types (mirror apps/web/lib/api/invoices.ts payment surface) ────────────────

export type PaymentStatus = "DRAFT" | "PAID" | "VOID";

export interface AllPayment {
  id: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  bankCharges?: number;
  paymentNumber?: string;
  status?: PaymentStatus;
  paymentGroupId?: string;
  paidAt?: string;
  createdAt: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    customerId: string;
    customer?: { id: string; businessName: string };
  };
}

export interface PaymentListParams {
  page?: number;
  limit?: number;
  customerId?: string;
  method?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface PaymentListResponse {
  data: AllPayment[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  summary: { totalReceived: number; count: number; advanceBalance: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useInvoicePayments(params?: PaymentListParams) {
  return useQuery<PaymentListResponse>({
    queryKey: ["invoices", "payments", params],
    queryFn: () => apiClient.get("/invoices/payments", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

/**
 * Single-payment fetch via the REAL endpoint `GET /invoices/payments/:paymentId`.
 * (Web's detail page instead does `useInvoicePayments({ limit: 200 }).find(...)`,
 * which 404s any payment past row 200 — mobile avoids that latent bug.)
 */
export function usePayment(id: string) {
  return useQuery<AllPayment>({
    queryKey: ["invoices", "payments", id],
    queryFn: () => apiClient.get(`/invoices/payments/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function invalidatePayments(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["invoices"] });
  qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
  qc.invalidateQueries({ queryKey: ["invoices", "payments", id] });
}

/**
 * Void a payment (`PATCH /invoices/:invoiceId/payments/:paymentId/void`). Server:
 * 404 if missing; 400 "Payment already voided" when status===VOID; else sets VOID
 * + recomputes the invoice status. Returns `{ success: true }`. Void is the only
 * reversal — there is no refund action.
 */
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { invoiceId: string; paymentId: string }>({
    mutationFn: ({ invoiceId, paymentId }) =>
      apiClient.patch(`/invoices/${invoiceId}/payments/${paymentId}/void`).then((r) => r.data),
    onSuccess: (_, { paymentId }) => invalidatePayments(qc, paymentId),
  });
}

/** Payment methods that are directly editable (Advance/Credit-Note are debited
 *  from a source balance and can't be hand-edited — server rejects them). */
export type EditablePaymentMethod = "CASH" | "CHECK" | "ACH" | "CREDIT_CARD" | "OTHER";

export interface UpdatePaymentDto {
  invoiceId: string;
  paymentId: string;
  method: EditablePaymentMethod;
  amount: number;
  paidAt?: string;
  bankCharges?: number;
  reference?: string;
  notes?: string;
}

/**
 * Correct a recorded payment (`PATCH /invoices/:invoiceId/payments/:paymentId`).
 * Server rejects CREDIT_NOTE/ADVANCE methods and VOID invoices, caps the amount
 * at `total − other payments`, and recomputes the invoice status. Mirrors web's
 * EditPaymentModal.
 */
export function useUpdatePayment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, UpdatePaymentDto>({
    mutationFn: ({ invoiceId, paymentId, ...body }) =>
      apiClient.patch(`/invoices/${invoiceId}/payments/${paymentId}`, body).then((r) => r.data),
    onSuccess: (_, { paymentId }) => invalidatePayments(qc, paymentId),
  });
}

// isPaymentEditable moved to lib/invoices-logic.ts (pure, unit-testable).

// Deferred (redundant with invoices/[id]/record-payment.tsx): standalone record
// (POST /invoices/payments/record), CSV export (GET /invoices/payments/export).
