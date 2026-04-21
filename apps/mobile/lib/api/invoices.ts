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

export type PaymentMethod = 'CASH' | 'CHECK' | 'ACH' | 'CREDIT_CARD' | 'CREDIT_NOTE' | 'ADVANCE' | 'OTHER';

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
      qc.invalidateQueries({ queryKey: ['invoices', invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoices', 'mine'] });
      qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
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

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation<Invoice, Error, { id: string; email?: string }>({
    mutationFn: ({ id, email }) =>
      apiClient
        .post(email ? `/invoices/${id}/send-email` : `/invoices/${id}/send`, email ? { email } : {})
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoices', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
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
      qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    },
  });
}

export function useInvoicePdf() {
  return useMutation<{ url: string } | null, Error, string>({
    mutationFn: async (id) => {
      try {
        const r = await apiClient.get(`/invoices/${id}/pdf`);
        return r.data ?? null;
      } catch (e: any) {
        if (e?.response?.status === 202) return null;
        throw e;
      }
    },
  });
}
