import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string };
  status: 'PENDING' | 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  lineItems: OrderItem[];
  createdAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  status: string;
  notes?: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useOrders(params?: { customerId?: string; status?: string; urgent?: boolean; page?: number; limit?: number }) {
  return useQuery<PaginatedResponse<Order>>({
    queryKey: ['orders', params],
    queryFn: () => apiClient.get('/orders', { params }).then((r) => r.data),
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
  return useMutation<Order, Error, { customerId: string; items: { productId: string; qty: number; notes?: string }[]; notes?: string; urgent?: boolean }>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: string }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/orders/${id}/status`, { status }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', id] });
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
