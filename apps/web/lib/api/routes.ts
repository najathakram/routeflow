import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface Route {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  _count?: { stops: number };
  runs?: RouteRun[];
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
  customerAddress?: { line1: string; city: string; state: string };
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
  const qc = useQueryClient();
  return useMutation<Route, Error, { name: string; driverId?: string }>({
    mutationFn: (dto) => apiClient.post('/routes', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routes'] }),
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
