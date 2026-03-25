import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplateItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string; pricePerUnit: string };
  qty: number;
  notes?: string;
}

export interface StandingOrder {
  id: string;
  name: string;
  isActive: boolean;
  daysOfWeek: number[]; // 0=Sun, 1=Mon, ... 6=Sat
  notes?: string;
  items: TemplateItem[];
  createdAt: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyStandingOrders() {
  return useQuery<{ data: StandingOrder[]; meta: any }>({
    queryKey: ['order-templates', 'mine'],
    queryFn: () =>
      apiClient.get('/order-templates').then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyStandingOrder(id: string) {
  return useQuery<StandingOrder>({
    queryKey: ['order-templates', id],
    queryFn: () => apiClient.get(`/order-templates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useToggleStandingOrder() {
  const qc = useQueryClient();
  return useMutation<StandingOrder, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      apiClient.patch(`/order-templates/${id}`, { isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order-templates'] }),
  });
}
