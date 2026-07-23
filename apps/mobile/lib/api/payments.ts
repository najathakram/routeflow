import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { PaymentMethod } from "./invoices"; // reuse the existing 7-value union
import type { ImageUploadFile } from "../product-image";

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
  // Payment image (receipt / slip / check photo). Grouped standalone rows
  // share one object keyed by paymentGroupId — these three fields are
  // identical across a group (server-anchored on upload).
  imageKey?: string | null;
  imageOriginalName?: string | null;
  imageMimeType?: string | null;
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

/**
 * Attach a receipt/slip/check photo to a payment — `POST
 * /invoices/payments/:paymentId/image`, multipart field `file`. Clones
 * `useUploadProductImages`'s FormData pattern (60s timeout — the server
 * compresses the image before storing it). Grouped standalone payments
 * anchor on the group id server-side, so uploading against any allocation
 * row's paymentId makes the image visible from all of them.
 */
export function useUploadPaymentImage() {
  const qc = useQueryClient();
  return useMutation<{ url: string }, Error, { paymentId: string; file: ImageUploadFile }>({
    mutationFn: ({ paymentId, file }) => {
      const fd = new FormData();
      fd.append("file", file as unknown as Blob);
      return apiClient
        .post(`/invoices/payments/${paymentId}/image`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60_000,
        })
        .then((r) => r.data);
    },
    onSuccess: (_, { paymentId }) => {
      invalidatePayments(qc, paymentId);
      // The invoice detail screen reads payment rows off useAdminInvoice
      // (lib/api/admin.ts), a separate cache from ["invoices", ...].
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

/** Presigned URL for a payment's attached image — `GET /invoices/payments/:paymentId/image`.
 *  A mutation (not a query) so callers fetch-on-demand (View/Open) rather than
 *  keeping a cached URL around; mirrors web's `useGetPaymentImageUrl`. */
export function useGetPaymentImageUrl() {
  return useMutation<{ url: string }, Error, string>({
    mutationFn: (paymentId) =>
      apiClient.get(`/invoices/payments/${paymentId}/image`).then((r) => r.data),
  });
}

/** Remove a payment's attached image — `DELETE /invoices/payments/:paymentId/image`. */
export function useDeletePaymentImage() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (paymentId) =>
      apiClient.delete(`/invoices/payments/${paymentId}/image`).then((r) => r.data),
    onSuccess: (_, paymentId) => {
      invalidatePayments(qc, paymentId);
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

// Deferred (redundant with invoices/[id]/record-payment.tsx): standalone record
// (POST /invoices/payments/record), CSV export (GET /invoices/payments/export).
