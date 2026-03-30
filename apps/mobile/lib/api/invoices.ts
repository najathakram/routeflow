import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID';

export interface InvoiceItem {
  id: string;
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: 'CASH' | 'CHECK' | 'ACH' | 'OTHER';
  reference?: string;
  paidAt: string;
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

export function useMyInvoices(params?: { status?: string; page?: number }) {
  return useQuery<PaginatedResponse<Invoice>>({
    queryKey: ['invoices', 'mine', params],
    queryFn: () =>
      apiClient.get('/invoices', { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyInvoice(id: string) {
  return useQuery<Invoice>({
    queryKey: ['invoices', id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface RecordPaymentDto {
  invoiceId: string;
  amount: number;
  method: InvoicePayment['method'];
  reference?: string;
  paidAt?: string;
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation<InvoicePayment, Error, RecordPaymentDto>({
    mutationFn: ({ invoiceId, ...body }) =>
      apiClient.post(`/invoices/${invoiceId}/payments`, body).then((r) => r.data),
    onSuccess: (_, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ['invoices', invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoices', 'mine'] });
    },
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: any) => apiClient.post('/invoices', dto).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}
