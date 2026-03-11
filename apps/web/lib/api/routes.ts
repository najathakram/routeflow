import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface RouteTemplateStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: { id: string; businessName: string };
  customerAddress?: { id: string; label?: string; line1: string; city: string; state: string; lat?: number; lng?: number };
  notes?: string;
}

export interface Route {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  _count?: { stops: number };
  runs?: RouteRun[];
  stops?: RouteTemplateStop[];
}

export interface RouteRun {
  id: string;
  routeId: string;
  route?: { id: string; name: string };
  driverId?: string;
  driver?: { id: string; contactName: string };
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  scheduledDate: string;
  startedAt?: string;
  completedAt?: string;
  notes?: string;
  stops?: RouteRunStop[];
  _count?: { stops: number };
}

export interface RouteRunStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: { id: string; businessName: string; contactName: string };
  customerAddress?: { line1: string; city: string; state: string; lat?: number; lng?: number };
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  completedAt?: string;
  driverNote?: string;
  orders?: { id: string; orderNumber: string; status: string }[];
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// Routes
export function useRoutes(params?: { search?: string; isActive?: boolean; page?: number }) {
  return useQuery<PaginatedResponse<Route>>({
    queryKey: ['routes', params],
    queryFn: () => apiClient.get('/routes', { params }).then((r) => r.data),
  });
}

export function useRoute(id: string) {
  return useQuery<Route>({
    queryKey: ['routes', id],
    queryFn: () => apiClient.get(`/routes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRoute() {
  return useMutation<Route, Error, { name: string; driverId?: string }>({
    mutationFn: (dto) => apiClient.post('/routes', dto).then((r) => r.data),
    // NOTE: No auto-invalidation — caller must invalidate after stops are added
    // to avoid the race condition where the route list refreshes before stops exist.
  });
}

export function useAddStopToRoute() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { routeId: string; customerId: string; customerAddressId?: string; notes?: string }
  >({
    mutationFn: ({ routeId, ...dto }) =>
      apiClient.post(`/routes/${routeId}/stops`, dto).then((r) => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['routes', vars.routeId] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customer-route-assignments'] });
    },
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation<Route, Error, { id: string; name?: string; driverId?: string; isActive?: boolean }>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/routes/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['routes', id] });
      qc.invalidateQueries({ queryKey: ['routes'] });
    },
  });
}

export function useRemoveStop() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; stopId: string }>({
    mutationFn: ({ routeId, stopId }) =>
      apiClient.delete(`/routes/${routeId}/stops/${stopId}`).then((r) => r.data),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ['routes', routeId] });
      qc.invalidateQueries({ queryKey: ['customer-route-assignments'] });
      qc.invalidateQueries({ queryKey: ['route-packing-list', routeId] });
    },
  });
}

export function useReorderStops() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; order: { id: string; stopNumber: number }[] }>({
    mutationFn: ({ routeId, order }) =>
      apiClient.patch(`/routes/${routeId}/stops/reorder`, { order }).then((r) => r.data),
    onSuccess: (_, { routeId }) => qc.invalidateQueries({ queryKey: ['routes', routeId] }),
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/routes/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['customer-route-assignments'] });
    },
  });
}

export function useReorderRunStops() {
  const qc = useQueryClient();
  return useMutation<void, Error, { runId: string; order: { id: string; stopNumber: number }[] }>({
    mutationFn: ({ runId, order }) =>
      apiClient.patch(`/route-runs/${runId}/stops/reorder`, { order }).then((r) => r.data),
    onSuccess: (_, { runId }) => qc.invalidateQueries({ queryKey: ['route-runs', runId] }),
  });
}

export interface PackingItem {
  productId: string;
  productName: string;
  sku?: string | null;
  totalQty: number;
  customers: { name: string; qty: number }[];
}

export interface PackingListResponse {
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
    total?: number;
    customer?: { id: string; businessName: string };
    lineItems: Array<{
      id: string;
      qty: number;
      unitPrice: number;
      product?: { id: string; name: string; sku?: string };
    }>;
  }>;
  packingList: PackingItem[];
}

export function useRoutePackingList(id: string) {
  return useQuery<PackingListResponse>({
    queryKey: ['route-packing-list', id],
    queryFn: () => apiClient.get(`/routes/${id}/packing-list`).then((r) => r.data),
    enabled: !!id,
  });
}

// Customer Route Assignments
export function useCustomerRouteAssignments() {
  return useQuery<Record<string, { routeId: string; routeName: string }[]>>({
    queryKey: ['customer-route-assignments'],
    queryFn: () => apiClient.get('/routes/customer-assignments').then((r) => r.data),
  });
}

// Route Runs
export function useRouteRuns(params?: { status?: string; date?: string; assignedToMe?: boolean; page?: number }) {
  return useQuery<PaginatedResponse<RouteRun>>({
    queryKey: ['route-runs', params],
    queryFn: () => apiClient.get('/route-runs', { params }).then((r) => r.data),
  });
}

export function useRouteRun(id: string) {
  return useQuery<RouteRun>({
    queryKey: ['route-runs', id],
    queryFn: () => apiClient.get(`/route-runs/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRouteRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { routeId: string; scheduledDate: string; driverId?: string; notes?: string }>({
    mutationFn: (dto) => apiClient.post('/route-runs', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-runs'] }),
  });
}

export function useUpdateRouteRunStatus() {
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

export interface OptimizeResult {
  stopOrder: Array<{ stopId: string; stopNumber: number }>;
  reorderedCount: number;
  usedFallback: boolean;
}

export function useOptimizeRoute() {
  const qc = useQueryClient();
  return useMutation<OptimizeResult, Error, string>({
    mutationFn: (id) =>
      apiClient.post<OptimizeResult>(`/route-runs/${id}/optimize`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['route-runs', id] });
      qc.invalidateQueries({ queryKey: ['route-runs'] });
    },
  });
}
