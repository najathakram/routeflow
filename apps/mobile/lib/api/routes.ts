import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteRunOrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  status: string;
}

export interface RouteRunOrder {
  id: string;
  orderNumber: string;
  status: string;
  urgent: boolean;
  notes?: string;
  invoiceId?: string;
  lineItems: RouteRunOrderItem[];
}

export interface RouteRunStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: {
    id: string;
    businessName: string;
    contactName: string;
    phone?: string;
    deliveryWindowStart?: string;
    deliveryWindowEnd?: string;
  };
  customerAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    lat?: number;
    lng?: number;
  };
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  completedAt?: string;
  arrivedAt?: string;
  driverNote?: string;
  notes?: string;
  orders?: RouteRunOrder[];
}

export interface RouteRun {
  id: string;
  route?: { id: string; name: string };
  driver?: { id: string; contactName: string };
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  scheduledDate: string;
  startedAt?: string;
  completedAt?: string;
  stops?: RouteRunStop[];
}

export interface PackingListItem {
  productId: string;
  productName: string;
  sku?: string;
  totalQty: number;
  customers: { name: string; qty: number }[];
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useActiveRouteRun() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ['route-runs', 'active'],
    queryFn: () =>
      apiClient
        .get('/route-runs', { params: { assignedToMe: true, status: 'IN_PROGRESS' } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useScheduledRouteRuns() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ['route-runs', 'scheduled'],
    queryFn: () =>
      apiClient
        .get('/route-runs', { params: { assignedToMe: true, status: 'SCHEDULED' } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useRouteRun(id: string) {
  return useQuery<RouteRun>({
    queryKey: ['route-runs', id],
    queryFn: () => apiClient.get(`/route-runs/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function usePackingList(runId: string) {
  return useQuery<PackingListItem[]>({
    queryKey: ['route-runs', runId, 'packing-list'],
    queryFn: () =>
      apiClient.get(`/route-runs/${runId}/packing-list`).then((r) => r.data?.packingList ?? r.data),
    enabled: !!runId,
    staleTime: 60_000,
  });
}

export function useDriverHistory() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ['route-runs', 'history'],
    queryFn: () =>
      apiClient
        .get('/route-runs', { params: { assignedToMe: true, limit: 30 } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useUpdateRunStatus() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; status: string }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/route-runs/${id}/status`, { status }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['route-runs'] });
      qc.invalidateQueries({ queryKey: ['route-runs', id] });
    },
  });
}

export type ItemDeliveryType = 'DELIVERED' | 'PARTIAL' | 'REFUSED' | 'ADD_ON';

export interface CompleteStopItemDto {
  orderItemId?: string; // undefined for ADD_ON items
  productId: string;
  type: ItemDeliveryType;
  qty: number;
  driverNote?: string;
}

export interface CompleteStopDto {
  runId: string;
  stopId: string;
  driverNote?: string;
  items: CompleteStopItemDto[];
}

export function useCompleteStop() {
  const qc = useQueryClient();
  return useMutation<RouteRunStop, Error, CompleteStopDto>({
    mutationFn: ({ runId, stopId, driverNote, items }) => {
      const deliveries = items
        .filter((i) => i.orderItemId) // API requires orderItemId; skip ADD_ON items without one
        .map((i) => ({
          orderItemId: i.orderItemId!,
          type: i.type,
          quantityDelivered: Math.round(i.qty),
          note: i.driverNote,
        }));
      return apiClient
        .post(`/route-runs/${runId}/stops/${stopId}/complete`, { driverNote, deliveries })
        .then((r) => r.data);
    },
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ['route-runs', runId] });
      qc.invalidateQueries({ queryKey: ['route-runs', 'active'] });
    },
  });
}

export function useUpdateStopStatus() {
  const qc = useQueryClient();
  return useMutation<RouteRunStop, Error, { runId: string; stopId: string; status: 'IN_PROGRESS' | 'SKIPPED'; driverNote?: string }>({
    mutationFn: ({ runId, stopId, ...body }) =>
      apiClient
        .patch(`/route-runs/${runId}/stops/${stopId}`, body)
        .then((r) => r.data),
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ['route-runs', runId] });
      qc.invalidateQueries({ queryKey: ['route-runs', 'active'] });
    },
  });
}
