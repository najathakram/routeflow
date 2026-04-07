import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type POStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED';

export interface POItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qtyOrdered: number;
  qtyReceived: number;
  unitCost: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: POStatus;
  supplier?: { id: string; name: string };
  supplierId: string;
  items: POItem[];
  expectedDate?: string;
  notes?: string;
  total?: number;
  createdAt: string;
}

export interface ReceivePODto {
  items: { itemId: string; qtyReceived: number }[];
  notes?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function usePurchaseOrders(status?: POStatus) {
  return useQuery<{ data: PurchaseOrder[]; meta: any }>({
    queryKey: ['purchase-orders', status ?? 'all'],
    queryFn: () =>
      apiClient
        .get('/inventory/purchase-orders', { params: status ? { status } : undefined })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useOpenPurchaseOrders() {
  // Open = DRAFT or SENT or PARTIALLY_RECEIVED
  return useQuery<{ data: PurchaseOrder[]; meta: any }>({
    queryKey: ['purchase-orders', 'open'],
    queryFn: async () => {
      const [draft, sent, partial] = await Promise.all([
        apiClient.get('/inventory/purchase-orders', { params: { status: 'DRAFT' } }).then((r) => r.data),
        apiClient.get('/inventory/purchase-orders', { params: { status: 'SENT' } }).then((r) => r.data),
        apiClient.get('/inventory/purchase-orders', { params: { status: 'PARTIALLY_RECEIVED' } }).then((r) => r.data),
      ]);
      const data = [
        ...(draft.data ?? []),
        ...(sent.data ?? []),
        ...(partial.data ?? []),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return { data, meta: { total: data.length } };
    },
    staleTime: 30_000,
  });
}

export function usePurchaseOrder(id: string) {
  return useQuery<PurchaseOrder>({
    queryKey: ['purchase-orders', id],
    queryFn: () =>
      apiClient.get(`/inventory/purchase-orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useSuppliers() {
  return useQuery<any[]>({
    queryKey: ['suppliers'],
    queryFn: () =>
      apiClient.get('/inventory/suppliers').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useReceivePO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, { id: string; dto: ReceivePODto }>({
    mutationFn: ({ id, dto }) =>
      apiClient.post(`/inventory/purchase-orders/${id}/receive`, dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, any>({
    mutationFn: (dto) =>
      apiClient.post('/inventory/purchase-orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-orders'] }),
  });
}
