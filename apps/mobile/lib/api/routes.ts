import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveryMutation {
  id: string;
  orderItemId: string;
  productId: string;
  type: 'DELIVERED' | 'PARTIAL' | 'REFUSED' | 'ADD_ON';
  quantityDelivered: number;
  note?: string;
  createdAt: string;
  product?: { id: string; name: string; unit: string };
}

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
  podPhotoUrls?: string[];
  safeDropEnabled?: boolean;
  signatureUrl?: string;
  notes?: string;
  orders?: RouteRunOrder[];
  deliveryMutations?: DeliveryMutation[];
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
  unit?: string;
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

export interface DriverStats {
  totalStopsCompleted: number;
  onTimeDeliveryPct: number;
  avgStopsPerRoute: number;
  returnsRate: number;
}

export function useDriverStats() {
  return useQuery<DriverStats>({
    queryKey: ['route-runs', 'my-stats'],
    queryFn: () =>
      apiClient
        .get('/route-runs/my-stats')
        .then((r) => r.data)
        .catch((err) => {
          // Gracefully handle 404 — endpoint may not exist yet
          if (err?.response?.status === 404) return null;
          throw err;
        }),
    staleTime: 5 * 60_000,
    retry: false,
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
  podPhotoUrls?: string[];
  signatureUrl?: string;
  safeDropEnabled?: boolean;
}

export function useCompleteStop() {
  const qc = useQueryClient();
  return useMutation<RouteRunStop, Error, CompleteStopDto>({
    mutationFn: ({ runId, stopId, driverNote, items, podPhotoUrls, signatureUrl, safeDropEnabled }) => {
      const deliveries = items
        .filter((i) => i.orderItemId) // API requires orderItemId; skip ADD_ON items without one
        .map((i) => ({
          orderItemId: i.orderItemId!,
          type: i.type,
          quantityDelivered: Math.round(i.qty),
          note: i.driverNote,
        }));
      return apiClient
        .post(`/route-runs/${runId}/stops/${stopId}/complete`, { driverNote, deliveries, podPhotoUrls, signatureUrl, safeDropEnabled })
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

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { routeId: string; scheduledDate: string; notes?: string }>({
    mutationFn: (dto) => apiClient.post('/route-runs', dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['route-runs'] });
    },
  });
}

export function useUpdateRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; scheduledDate?: string; notes?: string }>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/route-runs/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['route-runs'] });
      qc.invalidateQueries({ queryKey: ['route-runs', id] });
    },
  });
}

export function useAllRoutes() {
  return useQuery<{ data: { id: string; name: string; isActive: boolean }[]; meta: any }>({
    queryKey: ['routes'],
    queryFn: () => apiClient.get('/routes', { params: { limit: 100 } }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// ─── Route templates (operator) ───────────────────────────────────────────────

export interface CreateRouteDto {
  name: string;
  description?: string;
  stops?: { customerId: string; notes?: string }[];
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, CreateRouteDto>({
    mutationFn: (dto) => apiClient.post('/routes', dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['admin', 'routes'] });
    },
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { id: string; name?: string; description?: string; isActive?: boolean; driverId?: string | null }
  >({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/routes/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['admin', 'routes'] });
      qc.invalidateQueries({ queryKey: ['admin', 'routes', id] });
    },
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/routes/${id}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['admin', 'routes'] });
    },
  });
}

export function useAddRouteStop() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { routeId: string; customerId: string; notes?: string }
  >({
    mutationFn: ({ routeId, ...body }) =>
      apiClient.post(`/routes/${routeId}/stops`, body).then((r) => r.data),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'routes', routeId] });
    },
  });
}

export function useRemoveRouteStop() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; stopId: string }>({
    mutationFn: ({ routeId, stopId }) =>
      apiClient.delete(`/routes/${routeId}/stops/${stopId}`).then(() => undefined),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'routes', routeId] });
    },
  });
}

export function useReorderRouteStops() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { routeId: string; order: { id: string; stopNumber: number }[] }
  >({
    mutationFn: ({ routeId, order }) =>
      apiClient.patch(`/routes/${routeId}/stops/reorder`, { order }).then(() => undefined),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'routes', routeId] });
    },
  });
}

// ─── Live fleet (operator) ────────────────────────────────────────────────────

export interface LiveRoute {
  runId: string;
  routeId: string;
  routeName: string;
  driverId: string | null;
  driverName: string | null;
  status: string;
  latestLocation: {
    lat: number;
    lng: number;
    recordedAt: string;
    speedKph?: number | null;
    heading?: number | null;
  } | null;
  stops: {
    id: string;
    customerId: string;
    customerName: string;
    lat: number | null;
    lng: number | null;
    stopNumber: number;
    status: string;
  }[];
  nextStopIndex: number;
}

export function useRoutesLive() {
  return useQuery<{ routes: LiveRoute[] }>({
    queryKey: ['routes', 'live'],
    queryFn: () =>
      apiClient
        .get('/routes/live')
        .then((r) => r.data)
        .catch((err) => {
          if (err?.response?.status === 404) return { routes: [] };
          throw err;
        }),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useReopenStop() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean; message: string }, Error, { runId: string; stopId: string }>({
    mutationFn: ({ runId, stopId }) =>
      apiClient.post(`/route-runs/${runId}/stops/${stopId}/reopen`).then((r) => r.data),
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ['route-runs', runId] });
      qc.invalidateQueries({ queryKey: ['route-runs', 'active'] });
      qc.invalidateQueries({ queryKey: ['route-runs', 'history'] });
    },
  });
}
