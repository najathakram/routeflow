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
  | 'OVERDUE';

export interface InvoiceItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; unit?: string };
  description: string;
  qty: number;
  unitPrice: number;
  taxable: boolean;
  total: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER';
  reference?: string;
  notes?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  status: InvoiceStatus;
  dueDate?: string;
  subtotal: number;
  taxAmount?: number;
  tax?: number;
  total: number;
  notes?: string;
  terms?: string;
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
