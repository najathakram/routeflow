import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  status: string;
}

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'OUT_FOR_DELIVERY'
  | 'PARTIALLY_DELIVERED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  driverNote?: string;
  requestedDeliveryDate?: string;
  deliveredAt?: string;
  lineItems: OrderItem[];
  createdAt: string;
}

export interface CreateOrderDto {
  items: { productId: string; qty: number }[];
  notes?: string;
  urgent?: boolean;
  requestedDeliveryDate?: string;
}

export interface CreateOrderAsDriverDto {
  customerId: string;
  /**
   * `qty` is total pieces. When the operator splits a boxed product into
   * boxes+pieces, also include those — the server recomputes `qty` from
   * them and uses them for line-subtotal proration (BOX price × box-equivalent).
   */
  items: { productId: string; qty: number; boxes?: number; pieces?: number }[];
  notes?: string;
  routeRunId?: string;
  routeRunStopId?: string;
  immediateDelivery?: boolean;
  /**
   * Operator's choice when an active draft/pending order already exists for the customer.
   * If omitted and an active order exists, the API responds 409 with the active-order
   * summary so the UI can prompt.
   */
  mergeChoice?: 'merge' | 'separate';
}

export interface ActiveOrderSummary {
  id: string;
  orderNumber: string | null;
  status: 'DRAFT' | 'PENDING';
  itemCount: number;
  total: number;
  createdAt: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyOrders(params?: { status?: string; page?: number; limit?: number }) {
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

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, CreateOrderDto>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useCreateOrderAsDriver() {
  const qc = useQueryClient();
  return useMutation<Order, Error, CreateOrderAsDriverDto>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: (_, vars) => {
      if (vars.routeRunId) qc.invalidateQueries({ queryKey: ['route-runs', vars.routeRunId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useConfirmOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (orderId) =>
      apiClient.patch(`/orders/${orderId}/status`, { status: 'CONFIRMED' }).then((r) => r.data),
    onSuccess: () => {
      // Invalidate orders list AND route-runs so the "N to confirm" pill updates immediately
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['route-runs'] });
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) =>
      apiClient.patch(`/orders/${id}/status`, { status: 'CANCELLED' }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    {
      orderId: string;
      items: Array<{
        productId: string;
        qty: number;
        /** Optional box/piece split for boxed products (server recomputes qty) */
        boxes?: number;
        pieces?: number;
        unitPrice: number;
        overrideReason?: string;
      }>;
    }
  >({
    mutationFn: ({ orderId, items }) =>
      apiClient.patch(`/orders/${orderId}/items`, { items }).then((r) => r.data),
    onSuccess: (_, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['admin', 'orders'] });
      qc.invalidateQueries({ queryKey: ['admin', 'orders', orderId] });
    },
  });
}

export function useToggleOrderUrgent() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; urgent: boolean }>({
    mutationFn: ({ id, urgent }) =>
      apiClient.patch(`/orders/${id}/urgent`, { urgent }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useChangeOrderStatus() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: OrderStatus }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/orders/${id}/status`, { status }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['route-runs'] });
    },
  });
}

export function useCreateAdminOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { customerId: string; items: { productId: string; qty: number }[]; notes?: string; urgent?: boolean; immediateDelivery?: boolean; mergeChoice?: 'merge' | 'separate' }>({
    mutationFn: (dto) => apiClient.post('/orders', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

/**
 * Look up the most recent DRAFT/PENDING order for a customer (operator only).
 * Used by the operator's create-order screen to ask whether to merge or keep separate.
 */
export function useActiveOrderForCustomer(customerId: string | null | undefined) {
  return useQuery<ActiveOrderSummary | null>({
    queryKey: ['orders', 'active', customerId],
    queryFn: () =>
      apiClient.get('/orders/active', { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/orders/${id}`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export interface OrderTracking {
  runId: string;
  routeName: string | null;
  driverName: string | null;
  runStatus: string;
  stopNumber: number;
  stopStatus: string;
  stopsAhead: number;
  estimatedArrivalWindow: { start: string | null; end: string | null };
}

export function useOrderTracking(orderId: string, orderStatus?: string) {
  return useQuery<{ status: string; tracking: OrderTracking | null }>({
    queryKey: ['orders', orderId, 'tracking'],
    queryFn: () => apiClient.get(`/orders/${orderId}/tracking`).then((r) => r.data),
    enabled: !!orderId && orderStatus === 'OUT_FOR_DELIVERY',
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

