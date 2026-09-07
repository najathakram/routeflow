import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { fetchPdfBlob } from "../fetch-pdf-blob";
import type { AnyPaymentMethod, SelectablePaymentMethod } from "../payment-methods";
import type {
  CreateInvoiceItem,
  CreatePartialInvoiceDto,
  CreateRecurringInvoiceDto,
  InvoiceKpiSummary,
  PaymentListParams,
  PaymentListResponse,
  PriceType,
  RecurringInvoice,
  SendInvoiceEmailResult,
  SetCheckStatusDto,
  StandalonePaymentDto,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  "DRAFT" | "SENT" | "VIEWED" | "PARTIAL" | "PAID" | "VOID" | "OVERDUE" | "WRITTEN_OFF";

// `PriceType` re-exported from @routeflow/types (wave E / imp-10b R2: was
// declared identically here AND in `orders.ts` — collapsed to one import).
//
// X1 note on the payment DTO below: its `TMethod` stays generic
// (defaults to plain `string`) in `packages/types/api/finance.ts`, on
// purpose, so each app can plug in its own hand-curated "enterable" method
// union. Do NOT bind that parameter with a same-named local alias in this
// file (i.e. a re-declaration of the identifier as a narrowed alias) — the
// T1 sweep's "no local re-declaration in lib/api" guards (the shared-dto
// inventory spec and the shared-dto-rewrite codemod's `--check`) read this
// file's raw text and can't tell a narrowing alias apart from a forked
// duplicate. Bind the narrow union at each USE site instead — see
// `useRecordPaymentStandalone` below, which applies `<SelectablePaymentMethod>`
// where it types the mutation payload.
export type {
  CreateInvoiceItem,
  CreatePartialInvoiceDto,
  CreatePartialInvoiceItem,
  CreateRecurringInvoiceDto,
  PaymentListParams,
  PaymentListResponse,
  PriceType,
  RecurringInvoice,
  RecurringInvoiceItem,
  SendInvoiceEmailResult,
  SetCheckStatusDto,
  StandalonePaymentDto,
} from "@routeflow/types";

/** P5-12: lifecycle of a CHECK InvoicePayment. Always null/absent on non-check payments. */
export type CheckStatus = "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED";

export interface InvoiceItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; unit?: string; unitsPerBox?: number | null };
  description: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  originalPrice?: number | null;
  priceType?: PriceType;
  taxRate?: number;
  subtotal?: number;
  /** Regulated category snapshot (set at invoice creation) — drives credit-note ledger reversal. */
  trackedCategoryId?: string | null;
  /** Boxed split persisted server-side (unitsPerBox > 1 products). */
  boxes?: number | null;
  pieces?: number | null;
  /** Sale-time box-size snapshot. Recompute this line with THIS, never the live product. */
  unitsPerBox?: number | null;
  /** BUY_N_GET_M snapshot: whole free selling units on this line (boxes for a
   *  boxed line). MUST be round-tripped by the edit form — the PATCH items path
   *  replaces every line, and dropping it re-prices the line to full. */
  promoFreeUnits?: number | null;
  /** Per-line note carried from the order line (buyer-visible; prints on the PDF). */
  notes?: string | null;
  /** Provenance back to the source order line (null for manual/freeform lines). */
  orderItemId?: string | null;
  taxable?: boolean;
  total?: number;
  /**
   * Suggested retail price snapshotted at line-creation time (per PIECE, even
   * on a boxed line) — never re-read from the live product, so an issued
   * invoice's MSRP never changes. null/absent = render nothing.
   */
  msrp?: number | null;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: AnyPaymentMethod;
  status?: "DRAFT" | "PAID" | "VOID";
  reference?: string;
  notes?: string;
  paymentNumber?: string;
  paidAt?: string;
  createdAt: string;
  /** When the money landed in the bank. May be a future date (post-dated check). */
  settledAt?: string | null;
  /** P5-12 check lifecycle — only ever set when method = CHECK. */
  checkStatus?: CheckStatus | null;
  depositedAt?: string | null;
  clearedAt?: string | null;
  bouncedAt?: string | null;
  /** NSF fee billed to the customer when checkStatus = BOUNCED (0/absent = no fee). */
  nsfFeeAmount?: number | null;
  /** Payment image (receipt/slip/check photo). Grouped standalone rows share one image. */
  imageKey?: string | null;
  imageOriginalName?: string | null;
  imageMimeType?: string | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customer?: {
    id: string;
    businessName: string;
    contactName?: string;
    phone?: string;
    mobile?: string;
    email?: string;
    address?: string;
  };
  status: InvoiceStatus;
  dueDate?: string;
  issueDate?: string;
  subtotal: number;
  taxAmount?: number;
  discount?: number;
  shippingFee?: number;
  tax?: number;
  total: number;
  notes?: string;
  internalNotes?: string;
  referenceNumber?: string;
  subject?: string;
  terms?: string;
  /**
   * Structured "Net 30"-style label, distinct from `terms` (the long-form
   * Terms & Conditions text) — always agrees with `dueDate` on every invoice
   * this label was set on.
   */
  paymentTermsLabel?: string | null;
  /** Deposit schedule (Tier 1, deliberately minimal): percent of `total` due by
   *  `depositDueDate`. `depositAmount`/`depositOverdue` are server-computed at
   *  read time, never stored. */
  depositPercent?: number | null;
  depositDueDate?: string | null;
  depositAmount?: number | null;
  depositOverdue?: boolean;
  /** Tenant display preference (rides the payload so CUSTOMER viewers get it too). */
  hideOriginalPrice?: boolean;
  pdfUrl?: string;
  writeOffReason?: string;
  writtenOffAt?: string;
  orderId?: string;
  /** Set on per-batch delivery invoices; null/absent on the order-level "pending mirror" draft. */
  deliveryBatchId?: string | null;
  /** Linked order summary (present on the detail endpoint) — used to gate the pending-mirror draft. */
  order?: { status: string; orderNumber?: string | null };
  recurringInvoiceId?: string;
  items?: InvoiceItem[];
  payments?: InvoicePayment[];
  /** Server-computed balance due — 0 for PAID/VOID/WRITTEN_OFF regardless of payment records */
  balanceDue?: number;
  /** Server-computed total amount paid across all InvoicePayment records */
  paidAmount?: number;
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  paidAt?: string;
}

export interface InvoiceSummary {
  total: number;
  draft: number;
  sent: number;
  paid: number;
  overdue: number;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useInvoices(
  params?: {
    customerId?: string;
    status?: string;
    /**
     * Multi-status filter — sent instead of `status` (never both) to compose a
     * status SET, e.g. the "unpaid" statuses (SENT/VIEWED/PARTIAL/OVERDUE) the
     * due-soon chips apply when no single status tab is explicitly picked.
     * Mirrors the API's pre-existing `statuses` (`ListInvoicesDto`) IN-clause.
     */
    statuses?: string[];
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    /** Due-date window (YYYY-MM-DD, inclusive) — the invoices-page due-soon chips. */
    dueFrom?: string;
    dueTo?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    page?: number;
    limit?: number;
    /** When true, return ONLY invoices that have a tracking number (shipments list). */
    shipped?: boolean;
    /**
     * Derived-overdue filter: status in SENT/VIEWED/PARTIAL/OVERDUE AND dueDate
     * in the past — broader than `status: "OVERDUE"` alone (mirrors the API's
     * `ListInvoicesDto.isOverdue`).
     */
    isOverdue?: boolean;
  },
  options?: { refetchInterval?: number; enabled?: boolean },
) {
  return useQuery<PaginatedResponse<Invoice>>({
    queryKey: ["invoices", params],
    queryFn: () => apiClient.get("/invoices", { params }).then((r) => r.data),
    ...options,
  });
}

/**
 * B12: the invoices page's six KPI tiles, computed server-side over the
 * tenant's whole OPEN set — replaces `useInvoices({ limit: 999 })` +
 * client-side reduce, which silently dropped whichever invoices page 1000+
 * would have held. `today` is the VIEWER's own calendar day (`YYYY-MM-DD`)
 * so the tiles agree with the due-soon chips (L-047 — never derived from the
 * server's clock).
 */
export function useInvoiceKpiSummary(today: string) {
  return useQuery<InvoiceKpiSummary>({
    queryKey: ["invoices", "kpi-summary", today],
    queryFn: () =>
      apiClient.get("/invoices/kpi-summary", { params: { today } }).then((r) => r.data),
    enabled: !!today,
  });
}

export function useInvoice(id: string) {
  return useQuery<Invoice>({
    queryKey: ["invoices", id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export interface AllPayment {
  id: string;
  amount: number;
  method: AnyPaymentMethod;
  reference?: string;
  notes?: string;
  bankCharges?: number;
  paymentNumber?: string;
  status?: "DRAFT" | "PAID" | "VOID";
  paymentGroupId?: string;
  paidAt?: string;
  createdAt: string;
  /** When the money landed in the bank. May be a future date (post-dated check). */
  settledAt?: string | null;
  /** Payment image (receipt/slip/check photo). Grouped standalone rows share one image. */
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

export function useInvoicePayments(params?: PaymentListParams) {
  return useQuery<PaymentListResponse<AllPayment>>({
    queryKey: ["invoices", "payments", params],
    queryFn: () => apiClient.get("/invoices/payments", { params }).then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateInvoiceDto {
  customerId: string;
  dueDate?: string;
  issueDate?: string;
  discount?: number;
  shippingFee?: number;
  items: CreateInvoiceItem[];
  notes?: string;
  terms?: string;
  referenceNumber?: string;
  subject?: string;
  /** Carrier shipment tracking recorded at creation time. */
  shippingCarrier?: string;
  shippingTrackingNumber?: string;
  /** If true, invoice transitions DRAFT → SENT immediately after creation. */
  send?: boolean;
  /**
   * Structured "Net 30"-style label — whichever term string drove `dueDate`
   * above. Distinct from `terms` (the long-form Terms & Conditions text).
   */
  paymentTermsLabel?: string;
  /** Deliberately minimal deposit schedule (Tier 1): percent of the total due
   *  by `depositDueDate`. The dollar amount is always derived server-side. */
  depositPercent?: number;
  depositDueDate?: string;
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, CreateInvoiceDto>({
    mutationFn: (dto) => apiClient.post("/invoices", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string } & Partial<CreateInvoiceDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/invoices/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

/**
 * WP3: narrow post-issue correction of exactly `{ dueDate?, paymentTermsLabel?,
 * referenceNumber?, subject? }` — never items/discount/shipping/deposit, which
 * still require a credit note or a DRAFT edit. The server rejects VOID/
 * WRITTEN_OFF invoices; a dueDate change re-runs recomputeStatus (can flip
 * SENT↔OVERDUE) but never triggers the order back-sync.
 */
export interface UpdateInvoiceTermsDto {
  dueDate?: string;
  paymentTermsLabel?: string;
  referenceNumber?: string;
  subject?: string;
}

export function useUpdateInvoiceTerms() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string } & UpdateInvoiceTermsDto>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/invoices/${id}/terms`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

/**
 * Record / update / clear the carrier shipment on any non-void invoice.
 * Empty strings clear the carrier + tracking number. Returns the updated invoice.
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
    },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

/** DRAFT (proforma, pre-delivery) vs FINAL (issued) invoice-PDF stage. */
export type InvoicePdfVariant = "draft" | "final";

/**
 * Default PDF stage when the operator hasn't forced one: FINAL once the invoice is
 * issued (status beyond DRAFT) or its order is delivered, else DRAFT (the pre-delivery
 * proforma). Hand-mirrored across `apps/api/src/invoices/invoice-pdf-variant.ts` and
 * `apps/mobile/lib/invoice-pdf-variant.ts` — keep the three in sync (pricing.ts-style
 * triple mirror). The operator can always override and print/download/email either.
 */
export function deriveInvoiceVariant(inv: {
  status: string;
  order?: { status?: string | null } | null;
}): InvoicePdfVariant {
  if (inv.status !== "DRAFT") return "final";
  if (inv.order?.status === "DELIVERED") return "final";
  return "draft";
}

export function useSendInvoiceEmail() {
  const qc = useQueryClient();
  return useMutation<
    SendInvoiceEmailResult,
    Error,
    { id: string; email?: string; variant?: InvoicePdfVariant }
  >({
    mutationFn: ({ id, email, variant }) =>
      apiClient.post(`/invoices/${id}/send-email`, { email, variant }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export function useSendInvoiceReminder() {
  const qc = useQueryClient();
  return useMutation<SendInvoiceEmailResult, Error, { id: string; email?: string }>({
    mutationFn: ({ id, email }) =>
      apiClient.post(`/invoices/${id}/send-reminder`, { email }).then((r) => r.data),
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
      // Voiding releases OrderItem.invoicedQty, so the source order's
      // "Split into invoice…" button should reappear immediately.
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useReopenInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/reopen`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export function useApplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { creditNoteId: string; invoiceId: string; amount?: number }>({
    mutationFn: ({ creditNoteId, ...data }) =>
      apiClient.post(`/credit-notes/${creditNoteId}/apply`, data).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", updated.id] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
    },
  });
}

export function useApplyAdvanceToInvoice() {
  const qc = useQueryClient();
  return useMutation<
    Invoice,
    Error,
    { customerId: string; advancePaymentId: string; invoiceId: string; amount?: number }
  >({
    mutationFn: ({ customerId, advancePaymentId, ...data }) =>
      apiClient
        .post(`/customers/${customerId}/advance-payments/${advancePaymentId}/apply`, data)
        .then((r) => r.data),
    onSuccess: (updated, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", updated.id] });
      qc.invalidateQueries({ queryKey: ["customers", customerId, "advance-payments"] });
    },
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation<{ id: string; message: string }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/invoices/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      // Same reason as void: releases OrderItem.invoicedQty so the order can
      // be re-split.
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useWriteOffInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiClient.post(`/invoices/${id}/write-off`, { reason }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export function useDownloadInvoicePdf() {
  // Two-step download. The /pdf endpoint returns { url } pointing at the
  // generated PDF — for local storage that URL is an absolute
  // https://api.../api/v1/uploads/... URL that STILL requires a JWT
  // (RF-075). The shared helper picks the right transport: same-origin →
  // auth'd client, external presigned → bare axios.
  return useMutation<
    { url: string; blob: Blob },
    Error,
    string | { id: string; variant?: InvoicePdfVariant }
  >({
    mutationFn: async (arg) => {
      const { id, variant } = typeof arg === "string" ? { id: arg, variant: undefined } : arg;
      const { url } = await apiClient
        .get<{ url: string }>(`/invoices/${id}/pdf`, { params: variant ? { variant } : undefined })
        .then((r) => r.data);
      const blob = await fetchPdfBlob(url, apiClient);
      return { url, blob };
    },
  });
}

export interface RecordInvoicePaymentDto {
  id: string;
  method: SelectablePaymentMethod;
  amount: number;
  paidAt?: string;
  /** Bank landing date. May be in the future; omit when unknown. */
  settledAt?: string | null;
  bankCharges?: number;
  status?: "DRAFT" | "PAID";
  reference?: string;
  notes?: string;
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice & { createdPaymentId?: string }, Error, RecordInvoicePaymentDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/invoices/${id}/payments`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export interface UpdateInvoicePaymentDto {
  invoiceId: string;
  paymentId: string;
  method: SelectablePaymentMethod;
  amount: number;
  paidAt?: string;
  /** Omit to keep the stored bank date; send null to clear it. */
  settledAt?: string | null;
  bankCharges?: number;
  status?: "DRAFT" | "PAID" | "VOID";
  reference?: string;
  notes?: string;
}

export function useUpdateInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, UpdateInvoicePaymentDto>({
    mutationFn: ({ invoiceId, paymentId, ...data }) =>
      apiClient.patch(`/invoices/${invoiceId}/payments/${paymentId}`, data).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", updated.id] });
    },
  });
}

export function useDeleteInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { invoiceId: string; paymentId: string }>({
    mutationFn: ({ invoiceId, paymentId }) =>
      apiClient.delete(`/invoices/${invoiceId}/payments/${paymentId}`).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", updated.id] });
    },
  });
}

/**
 * Attach an image (receipt/slip/check photo) to a payment. Grouped standalone
 * payments anchor on the group id server-side, so uploading against any
 * allocation row's paymentId makes the image visible from all of them.
 */
export function useUploadPaymentImage() {
  const qc = useQueryClient();
  return useMutation<{ url: string }, Error, { paymentId: string; file: File }>({
    mutationFn: ({ paymentId, file }) => {
      const form = new FormData();
      form.append("file", file);
      return apiClient
        .post(`/invoices/payments/${paymentId}/image`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        })
        .then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

export function useDeletePaymentImage() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (paymentId) =>
      apiClient.delete(`/invoices/payments/${paymentId}/image`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

export function useGetPaymentImageUrl() {
  return useMutation<{ url: string }, Error, string>({
    mutationFn: (paymentId) =>
      apiClient.get(`/invoices/payments/${paymentId}/image`).then((r) => r.data),
  });
}

export function useRecordPaymentStandalone() {
  const qc = useQueryClient();
  return useMutation<
    { payments: AllPayment[]; paymentGroupId: string; excess: number },
    Error,
    // X1: bind TMethod to web's enterable subset at the use site (not via a
    // local re-declaration — see the comment above `StandalonePaymentDto`'s
    // re-export).
    StandalonePaymentDto<SelectablePaymentMethod>
  >({
    mutationFn: (dto) => apiClient.post("/invoices/payments/record", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { invoiceId: string; paymentId: string }>({
    mutationFn: ({ invoiceId, paymentId }) =>
      apiClient.patch(`/invoices/${invoiceId}/payments/${paymentId}/void`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

/**
 * P5-12: advance a CHECK payment through Recorded→Deposited→Cleared→Bounced.
 * BOUNCED re-opens the invoice balance server-side, so this invalidates the
 * invoice list, the invoice detail (badge/balance), and the payments list.
 */
export function useSetCheckStatus() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean; checkStatus: CheckStatus }, Error, SetCheckStatusDto>({
    mutationFn: ({ invoiceId, paymentId, ...data }) =>
      apiClient
        .patch(`/invoices/${invoiceId}/payments/${paymentId}/check-status`, data)
        .then((r) => r.data),
    onSuccess: (_, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

export function useExportPayments() {
  return useMutation<void, Error, PaymentListParams>({
    mutationFn: async (params) => {
      const response = await apiClient.get("/invoices/payments/export", {
        params,
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `payments-${new Date().toISOString().split("T")[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    },
  });
}

export function usePaymentDetail(id: string) {
  return useQuery<AllPayment>({
    queryKey: ["invoices", "payments", id],
    queryFn: () => apiClient.get(`/invoices/payments/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Recurring invoices ───────────────────────────────────────────────────────

/**
 * REG-B106: mirrors `RUN_UNFINALIZED_ERROR` in
 * `apps/api/src/recurring-invoices/recurring-invoices.service.ts`. A `lastError` starting
 * with this text means the invoice WAS created (the cycle is billed) and only the run's
 * bookkeeping failed — so that failure must never be offered as a retry: re-running would
 * bill the same cycle twice.
 */
export const RUN_UNFINALIZED_PREFIX = "The invoice was created but the run could not be finalized";

/** True when a FAILED cycle produced no invoice, so "Run Now" is a safe retry. */
export function isRetryableRunFailure(lastError?: string | null): boolean {
  return !!lastError && !lastError.startsWith(RUN_UNFINALIZED_PREFIX);
}

export function useRecurringInvoices(customerId?: string) {
  return useQuery<RecurringInvoice[]>({
    queryKey: ["recurring-invoices", customerId],
    queryFn: () =>
      apiClient
        .get("/recurring-invoices", { params: customerId ? { customerId } : {} })
        .then((r) => r.data),
  });
}

export function useRecurringInvoice(id: string) {
  return useQuery<RecurringInvoice>({
    queryKey: ["recurring-invoices", id],
    queryFn: () => apiClient.get(`/recurring-invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, CreateRecurringInvoiceDto>({
    mutationFn: (dto) => apiClient.post("/recurring-invoices", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-invoices"] }),
  });
}

export function useUpdateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, { id: string } & Partial<CreateRecurringInvoiceDto>>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/recurring-invoices/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["recurring-invoices"] });
      qc.invalidateQueries({ queryKey: ["recurring-invoices", id] });
    },
  });
}

export function useDeactivateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, string>({
    mutationFn: (id) => apiClient.delete(`/recurring-invoices/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-invoices"] }),
  });
}

/**
 * Resume a paused template via the dedicated `POST /:id/activate` endpoint. The
 * old approach (`useUpdateRecurringInvoice` with `{ isActive: true }`) never
 * persisted — the PATCH was unvalidated before `UpdateRecurringInvoiceDto`
 * (F13/B92); it now validates and whitelists, and `isActive` is deliberately
 * absent from that DTO, so a `{ isActive: true }` PATCH is a 400 — the activate
 * endpoint stays the resume path.
 */
export function useActivateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/activate`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-invoices"] }),
  });
}

/**
 * Run a template now. The server claims the cycle atomically before generating,
 * so a losing racer (a second "Run now" tap, or the daily cron) gets NO invoice
 * back — the response body is empty. Typed nullable so callers must branch;
 * axios yields `""` for that empty body, so guard on `inv?.id`, not `inv != null`.
 */
export function useRunRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice | null, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/run`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["recurring-invoices"] });
    },
  });
}

export function useRevertInvoiceToDraft() {
  const qc = useQueryClient();
  return useMutation<any, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/revert-to-draft`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export function useUnvoidInvoice() {
  const qc = useQueryClient();
  return useMutation<any, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/unvoid`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

// ─── Generate Invoice from Order ──────────────────────────────────────────────

export function useCreateInvoiceFromOrder() {
  const qc = useQueryClient();
  // W4: a mixed regulated order returns >1 sibling invoice, so this is Invoice[].
  return useMutation<Invoice[], Error, string>({
    mutationFn: (orderId) => apiClient.post(`/invoices/from-order/${orderId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

// ─── Split / partial invoice from order ───────────────────────────────────────

/**
 * Create one of N partial invoices from an order. Operator picks which order items
 * (and how many of each) to bill on this invoice + a due date. Each call increments
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
    },
  });
}

// ─── Price Adjustment ─────────────────────────────────────────────────────────

export interface PriceAdjustmentItem {
  itemId: string;
  newUnitPrice: number;
}

export interface PriceAdjustmentDto {
  items: PriceAdjustmentItem[];
  scope: "SINGLE" | "ALL_CUSTOMER_SINCE";
  sinceDate?: string;
}

// ─── Invoice Settings ──────────────────────────────────────────────────────

export interface InvoiceSettings {
  defaultTerms: string;
  hideOriginalPrice?: boolean;
  /** Tenant-wide deposit default (0–100). null/absent = no tenant deposit policy;
   *  a customer's own `defaultDepositPercent` still wins when set. */
  depositDefaultPercent?: number | null;
  /** When true, an order's mirror invoice is ISSUED (SENT, no email) at
   *  placement so the deposit can be paid immediately; the order stays
   *  editable until delivery. */
  depositCollectAtOrder?: boolean;
}

export function useInvoiceSettings() {
  return useQuery<InvoiceSettings>({
    queryKey: ["invoice-settings"],
    queryFn: () => apiClient.get("/settings/invoice").then((r) => r.data),
  });
}

export function useUpdateInvoiceSettings() {
  const qc = useQueryClient();
  return useMutation<InvoiceSettings, Error, Partial<InvoiceSettings>>({
    mutationFn: (dto) => apiClient.patch("/settings/invoice", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoice-settings"] }),
  });
}

export function useAdjustInvoicePrices() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string } & PriceAdjustmentDto>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.post(`/invoices/${id}/price-adjustment`, dto).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", updated.id] });
    },
  });
}
