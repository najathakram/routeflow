import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { fetchPdfBlob } from "../fetch-pdf-blob";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "VIEWED"
  | "PARTIAL"
  | "PAID"
  | "VOID"
  | "OVERDUE"
  | "WRITTEN_OFF";

export type PriceType = "STANDARD" | "SPECIAL" | "DISCOUNTED";

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
  /** Boxed split persisted server-side (unitsPerBox > 1 products). */
  boxes?: number | null;
  pieces?: number | null;
  taxable?: boolean;
  total?: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_NOTE" | "ADVANCE";
  reference?: string;
  notes?: string;
  paidAt?: string;
  createdAt: string;
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
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    page?: number;
    limit?: number;
    /** When true, return ONLY invoices that have a tracking number (shipments list). */
    shipped?: boolean;
  },
  options?: { refetchInterval?: number },
) {
  return useQuery<PaginatedResponse<Invoice>>({
    queryKey: ["invoices", params],
    queryFn: () => apiClient.get("/invoices", { params }).then((r) => r.data),
    ...options,
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
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_NOTE" | "ADVANCE" | "CREDIT_CARD";
  reference?: string;
  notes?: string;
  bankCharges?: number;
  paymentNumber?: string;
  status?: "DRAFT" | "PAID" | "VOID";
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
  sortDir?: string;
}

export interface PaymentListResponse {
  data: AllPayment[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  summary: { totalReceived: number; count: number; advanceBalance: number };
}

export function useInvoicePayments(params?: PaymentListParams) {
  return useQuery<PaymentListResponse>({
    queryKey: ["invoices", "payments", params],
    queryFn: () => apiClient.get("/invoices/payments", { params }).then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateInvoiceItem {
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  taxRate?: number;
  discount?: number;
  boxes?: number;
  pieces?: number;
}

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

export function useSendInvoiceEmail() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean; sentTo: string }, Error, { id: string; email?: string }>({
    mutationFn: ({ id, email }) =>
      apiClient.post(`/invoices/${id}/send-email`, { email }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", id] });
    },
  });
}

export function useSendInvoiceReminder() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean; sentTo: string }, Error, { id: string; email?: string }>({
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
  return useMutation<{ url: string; blob: Blob }, Error, string>({
    mutationFn: async (id) => {
      const { url } = await apiClient
        .get<{ url: string }>(`/invoices/${id}/pdf`)
        .then((r) => r.data);
      const blob = await fetchPdfBlob(url, apiClient);
      return { url, blob };
    },
  });
}

export interface RecordInvoicePaymentDto {
  id: string;
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD";
  amount: number;
  paidAt?: string;
  bankCharges?: number;
  status?: "DRAFT" | "PAID";
  reference?: string;
  notes?: string;
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, RecordInvoicePaymentDto>({
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
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD";
  amount: number;
  paidAt?: string;
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

export interface StandalonePaymentDto {
  customerId: string;
  totalAmount: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD";
  paidAt?: string;
  bankCharges?: number;
  reference?: string;
  notes?: string;
  status?: "DRAFT" | "PAID";
  allocations: { invoiceId: string; amount: number }[];
}

export function useRecordPaymentStandalone() {
  const qc = useQueryClient();
  return useMutation<
    { payments: AllPayment[]; paymentGroupId: string; excess: number },
    Error,
    StandalonePaymentDto
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

export interface RecurringInvoiceItem {
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export interface RecurringInvoice {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  frequency: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  dayOfWeek?: number;
  dayOfMonth?: number;
  isActive: boolean;
  autoSend: boolean;
  notes?: string;
  terms?: string;
  discount?: number;
  shippingFee?: number;
  nextRunAt: string;
  lastRunAt?: string;
  items: RecurringInvoiceItem[];
  createdAt: string;
}

export interface CreateRecurringInvoiceDto {
  customerId: string;
  frequency: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  dayOfWeek?: number;
  dayOfMonth?: number;
  autoSend?: boolean;
  notes?: string;
  terms?: string;
  discount?: number;
  shippingFee?: number;
  nextRunAt: string;
  items: RecurringInvoiceItem[];
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

export function useRunRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
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
