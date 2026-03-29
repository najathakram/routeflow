import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'PARTIAL'
  | 'PAID'
  | 'VOID'
  | 'OVERDUE'
  | 'WRITTEN_OFF';

export interface InvoiceItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; unit?: string };
  description: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  subtotal?: number;
  taxable?: boolean;
  total?: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER' | 'CREDIT_NOTE' | 'ADVANCE';
  reference?: string;
  notes?: string;
  paidAt?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; phone?: string; address?: string };
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
  terms?: string;
  pdfUrl?: string;
  writeOffReason?: string;
  writtenOffAt?: string;
  recurringInvoiceId?: string;
  items?: InvoiceItem[];
  payments?: InvoicePayment[];
  balanceDue?: number;
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

export function useInvoices(params?: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<Invoice>>({
    queryKey: ['invoices', params],
    queryFn: () => apiClient.get('/invoices', { params }).then((r) => r.data),
  });
}

export function useInvoice(id: string) {
  return useQuery<Invoice>({
    queryKey: ['invoices', id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export interface AllPayment {
  id: string;
  amount: number;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER' | 'CREDIT_NOTE' | 'ADVANCE';
  reference?: string;
  notes?: string;
  createdAt: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    customerId: string;
    customer?: { id: string; businessName: string };
  };
}

export function useInvoicePayments(params?: { page?: number; limit?: number }) {
  return useQuery<{ data: AllPayment[]; meta: { total: number; page: number; limit: number; totalPages: number } }>({
    queryKey: ['invoices', 'payments', params],
    queryFn: () => apiClient.get('/invoices/payments', { params }).then((r) => r.data),
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
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, CreateInvoiceDto>({
    mutationFn: (dto) => apiClient.post('/invoices', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string } & Partial<CreateInvoiceDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/invoices/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
    },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
    },
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
    },
  });
}

export function useWriteOffInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => apiClient.post(`/invoices/${id}/write-off`, { reason }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
    },
  });
}

export function useDownloadInvoicePdf() {
  return useMutation<{ url: string }, Error, string>({
    mutationFn: (id) => apiClient.get(`/invoices/${id}/pdf`).then((r) => r.data),
  });
}

export interface RecordInvoicePaymentDto {
  id: string;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER';
  amount: number;
  reference?: string;
  notes?: string;
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, RecordInvoicePaymentDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/invoices/${id}/payments`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
    },
  });
}

export interface UpdateInvoicePaymentDto {
  invoiceId: string;
  paymentId: string;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER';
  amount: number;
  reference?: string;
  notes?: string;
}

export function useUpdateInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, UpdateInvoicePaymentDto>({
    mutationFn: ({ invoiceId, paymentId, ...data }) =>
      apiClient.patch(`/invoices/${invoiceId}/payments/${paymentId}`, data).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', updated.id] });
    },
  });
}

export function useDeleteInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { invoiceId: string; paymentId: string }>({
    mutationFn: ({ invoiceId, paymentId }) =>
      apiClient.delete(`/invoices/${invoiceId}/payments/${paymentId}`).then((r) => r.data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', updated.id] });
    },
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
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
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
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
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
    queryKey: ['recurring-invoices', customerId],
    queryFn: () => apiClient.get('/recurring-invoices', { params: customerId ? { customerId } : {} }).then((r) => r.data),
  });
}

export function useRecurringInvoice(id: string) {
  return useQuery<RecurringInvoice>({
    queryKey: ['recurring-invoices', id],
    queryFn: () => apiClient.get(`/recurring-invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, CreateRecurringInvoiceDto>({
    mutationFn: (dto) => apiClient.post('/recurring-invoices', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring-invoices'] }),
  });
}

export function useUpdateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, { id: string } & Partial<CreateRecurringInvoiceDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/recurring-invoices/${id}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring-invoices'] }),
  });
}

export function useDeactivateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, string>({
    mutationFn: (id) => apiClient.delete(`/recurring-invoices/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring-invoices'] }),
  });
}

export function useRunRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/run`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['recurring-invoices'] });
    },
  });
}
