import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface OrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  status: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: 'PENDING' | 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  lineItems: OrderItem[];
  createdAt: string;
}

export function useMyOrders(params?: { status?: string }) {
  return useQuery<{ data: Order[]; meta: any }>({
    queryKey: ['orders', 'mine', params],
    queryFn: () => apiClient.get('/orders', { params }).then((r) => r.data),
    staleTime: 30_000,
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
  return useMutation<Order, Error, { customerId: string; items: { productId: string; qty: number }[] }>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}
