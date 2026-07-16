import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { InvoicePdfVariant } from "../invoice-pdf-variant";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "VIEWED"
  | "PARTIAL"
  | "PAID"
  | "OVERDUE"
  | "VOID"
  | "WRITTEN_OFF";

export interface InvoiceItem {
  id: string;
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  /** Catalog base for an override line; unitPrice > originalPrice = upsell. */
  originalPrice?: number | null;
  /** STANDARD | SPECIAL | DISCOUNTED | MANUAL | PROMO. */
  priceType?: string;
  subtotal: number;
}

export type PaymentMethod =
  | "CASH"
  | "CHECK"
  | "ACH"
  | "CREDIT_CARD"
  | "CREDIT_NOTE"
  | "ADVANCE"
  | "OTHER";

export interface InvoicePayment {
  id: string;
  paymentNumber?: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  status?: string;
  bankCharges?: number;
  paidAt: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  subtotal: number;
  taxAmount: number;
  discount: number;
  total: number;
  dueDate?: string;
  notes?: string;
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  /** Set when the invoice was written off as bad debt (status WRITTEN_OFF). */
  writeOffReason?: string | null;
  writtenOffAt?: string | null;
  items?: InvoiceItem[];
  payments?: InvoicePayment[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyInvoices(params?: {
  status?: string;
  page?: number;
  /** When true, return ONLY invoices that have a tracking number (shipments list). */
  shipped?: boolean;
}) {
  return useQuery<PaginatedResponse<Invoice>>({
    queryKey: ["invoices", "mine", params],
    queryFn: () => apiClient.get("/invoices", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyInvoice(id: string) {
  return useQuery<Invoice>({
    queryKey: ["invoices", id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface RecordPaymentDto {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  bankCharges?: number;
  paidAt?: string;
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  // Backend returns the updated Invoice (not InvoicePayment)
  return useMutation<Invoice, Error, RecordPaymentDto>({
    mutationFn: ({ invoiceId, ...body }) =>
      apiClient.post(`/invoices/${invoiceId}/payments`, body).then((r) => r.data),
    onSuccess: (_, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices", "mine"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

export interface CreateInvoiceItem {
  /** Free-text label. For an unlisted (non-catalog) line, omit productId. */
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  /** Optional box/piece split for boxed products. Server prorates the line. */
  boxes?: number;
  pieces?: number;
}

export interface CreateInvoiceDto {
  customerId: string;
  items: CreateInvoiceItem[];
  dueDate?: string;
  terms?: string;
  notes?: string;
  /** Carrier shipment tracking recorded at creation time. */
  shippingCarrier?: string;
  shippingTrackingNumber?: string;
  send?: boolean;
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, CreateInvoiceDto>({
    mutationFn: (dto) => apiClient.post("/invoices", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; email?: string; variant?: InvoicePdfVariant }>({
    // Two branches: send-email (attaches the PDF at the chosen stage) vs `/send`
    // mark-as-sent (no email). `variant` rides ONLY on the send-email body — the
    // mark-as-sent call must stay bodyless.
    mutationFn: ({ id, email, variant }) =>
      apiClient
        .post(
          email ? `/invoices/${id}/send-email` : `/invoices/${id}/send`,
          email ? { email, ...(variant ? { variant } : {}) } : {},
        )
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
      // Voiding releases OrderItem.invoicedQty on the source order so the
      // operator can re-split. The order detail's "Split into invoice…"
      // visibility depends on `qty - invoicedQty` per line — without these
      // invalidations it stayed hidden until manual refetch.
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
  });
}

/**
 * Permanently delete an invoice. Server rejects if any payments are recorded
 * (operator must remove payments first or void). Typically used after voiding.
 */
/**
 * Write off an unpaid invoice as bad debt (`POST /invoices/:id/write-off`, body
 * `{ reason }`). Server allows only SENT | VIEWED | PARTIAL | OVERDUE → sets
 * status WRITTEN_OFF + writeOffReason/writtenOffAt. Not reversible.
 */
export function useWriteOffInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiClient.post(`/invoices/${id}/write-off`, { reason }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
    },
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation<{ id: string; message: string }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/invoices/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; dueDate?: string; notes?: string }>({
    mutationFn: ({ id, ...body }) => apiClient.patch(`/invoices/${id}`, body).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

/**
 * Record / update / clear the carrier shipment on any non-void invoice. Empty
 * strings clear the carrier + tracking number. Mirrors web's
 * `useUpdateInvoiceShipment`.
 */
export function useUpdateInvoiceShipment() {
  const qc = useQueryClient();
  return useMutation<
    Invoice,
    Error,
    { id: string; shippingCarrier?: string; shippingTrackingNumber?: string }
  >({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/invoices/${id}/shipment`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
    },
  });
}

// ─── Split / partial invoice from order ───────────────────────────────────────

export interface CreatePartialInvoiceItem {
  orderItemId: string;
  qty: number;
}

export interface CreatePartialInvoiceDto {
  orderId: string;
  items: CreatePartialInvoiceItem[];
  dueDate?: string;
  terms?: string;
  notes?: string;
  send?: boolean;
}

/**
 * Create one of N partial invoices from an order. Available to operator and driver
 * (driver uses it from the stop-completion flow). Each call increments
 * OrderItem.invoicedQty server-side so the order can't be over-invoiced.
 */
export function useCreatePartialInvoiceFromOrder() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, CreatePartialInvoiceDto>({
    mutationFn: ({ orderId, ...dto }) =>
      apiClient.post(`/invoices/from-order/${orderId}/partial`, dto).then((r) => r.data),
    onSuccess: (_, { orderId }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", orderId] });
      // Mobile order detail uses `useAdminOrder` (key `['admin', 'orders', id]`)
      // and the orders list uses `useAdminOrders`. Without these invalidations
      // the operator would tap "Split into invoice…" again and see the same
      // remaining qty (cached invoicedQty), then the second invoice would 400
      // with "Requested qty exceeds remaining." Whole flow looked broken.
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders", orderId] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

/**
 * Create (or fetch, idempotently) the full invoice for a delivered order —
 * `POST /invoices/from-order/:orderId`. Returns `Invoice[]` because a regulated
 * order can split into multiple invoices (one per license category). Safe to call
 * after the DELIVERED transition even though the server also fire-and-forget
 * auto-creates the draft: the endpoint returns the existing invoice(s) rather
 * than duplicating, and calling it here is how the client gets the id(s)
 * synchronously (the changeStatus auto-create doesn't block the response).
 */
export function useCreateInvoiceFromOrder() {
  const qc = useQueryClient();
  return useMutation<Invoice[], Error, string>({
    mutationFn: (orderId) =>
      apiClient.post(`/invoices/from-order/${orderId}`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : [d];
      }),
    onSuccess: (_, orderId) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders", orderId] });
    },
  });
}

/** DRAFT (proforma, pre-delivery) vs FINAL (issued) invoice-PDF stage. */
// Canonical type + smart-default live in ../invoice-pdf-variant (triple mirror with
// apps/api + apps/web); re-exported here so existing importers keep their path.
export type { InvoicePdfVariant };

export function useInvoicePdf() {
  return useMutation<
    { url: string } | null,
    Error,
    string | { id: string; variant?: InvoicePdfVariant }
  >({
    mutationFn: async (arg) => {
      const { id, variant } = typeof arg === "string" ? { id: arg, variant: undefined } : arg;
      try {
        const r = await apiClient.get(`/invoices/${id}/pdf`, {
          params: variant ? { variant } : undefined,
        });
        return r.data ?? null;
      } catch (e: any) {
        if (e?.response?.status === 202) return null;
        throw e;
      }
    },
  });
}
