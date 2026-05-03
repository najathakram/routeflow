import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export type PriceType = 'STANDARD' | 'SPECIAL' | 'DISCOUNTED';

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; phone?: string | null; mobile?: string | null; email?: string | null };
  status: 'DRAFT' | 'PENDING' | 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  discountAmount?: number;
  notes?: string;
  requestedDeliveryDate?: string;
  templateId?: string;
  lineItems: OrderItem[];
  createdAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string; unitsPerBox?: number | null };
  qty: number;
  unitPrice: number;
  originalPrice?: number | null;
  priceType?: PriceType;
  boxes?: number | null;
  pieces?: number | null;
  status: string;
  notes?: string;
  /** Cumulative qty already covered by issued invoices for this item. */
  invoicedQty?: number;
}

export interface ActiveOrderSummary {
  id: string;
  orderNumber: string | null;
  status: 'DRAFT' | 'PENDING';
  itemCount: number;
  total: number;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useOrders(
  params?: { customerId?: string; status?: string; urgent?: boolean; page?: number; limit?: number; deliveryDateFrom?: string; deliveryDateTo?: string },
  options?: { refetchInterval?: number },
) {
  return useQuery<PaginatedResponse<Order>>({
    queryKey: ['orders', params],
    queryFn: () => apiClient.get('/orders', { params }).then((r) => r.data),
    ...options,
  });
}

export function useOrder(id: string) {
  return useQuery<Order>({
    queryKey: ['orders', id],
    queryFn: () => apiClient.get(`/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, {
    customerId: string;
    items: { productId: string; qty: number; boxes?: number; pieces?: number; unitPrice?: number; notes?: string }[];
    notes?: string;
    urgent?: boolean;
    requestedDeliveryDate?: string;
    discountAmount?: number;
    /**
     * Operator's choice when an active draft/pending order already exists for the customer.
     * If omitted and an active order exists, the API responds 409 with the active-order
     * summary so the UI can prompt.
     */
    mergeChoice?: 'merge' | 'separate';
  }>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

/**
 * Look up the most recent DRAFT/PENDING order for a customer (operator only).
 * Used by the create-order modal to ask the operator whether to merge or keep separate.
 */
export function useActiveOrderForCustomer(customerId: string | null | undefined) {
  return useQuery<ActiveOrderSummary | null>({
    queryKey: ['orders', 'active', customerId],
    queryFn: () =>
      apiClient.get('/orders/active', { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: string; reason?: string }>({
    mutationFn: ({ id, status, reason }) =>
      apiClient.patch(`/orders/${id}/status`, { status, reason }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', id] });
    },
  });
}

export interface ItemUpdate {
  id: string;
  action?: 'CANCEL' | 'UPDATE';
  qty?: number;
  substituteProductId?: string;
  notes?: string;
}

export function useUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; items: ItemUpdate[]; orderNotes?: string }>({
    mutationFn: ({ id, items, orderNotes }) =>
      apiClient.patch<Order>(`/orders/${id}/items`, { items, orderNotes }).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(['orders', data.id], data);
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useToggleUrgent() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => apiClient.patch(`/orders/${id}/urgent`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', id] });
    },
  });
}

export function useReopenOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => apiClient.post(`/orders/${id}/reopen`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', id] });
    },
  });
}

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/orders/${id}`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.removeQueries({ queryKey: ['orders', id] });
    },
  });
}

export function useBulkDeleteOrders() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; errors: string[] }, Error, string[]>({
    mutationFn: (ids) => apiClient.delete('/orders/bulk', { data: { ids } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}
