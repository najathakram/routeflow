import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface RouteRunStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: { id: string; businessName: string; contactName: string };
  customerAddress?: { line1: string; line2?: string; city: string; state: string; zip: string };
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  completedAt?: string;
  driverNote?: string;
  orders?: { id: string; orderNumber: string; status: string }[];
}

export interface RouteRun {
  id: string;
  route?: { id: string; name: string };
  driver?: { id: string; contactName: string };
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  scheduledDate: string;
  startedAt?: string;
  stops?: RouteRunStop[];
}

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
  });
}

export function useUpdateRunStatus() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; status: string }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/route-runs/${id}/status`, { status }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['route-runs'] });
    },
  });
}
