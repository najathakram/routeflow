import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

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
  customer?: { id: string; businessName: string };
  createdAt: string;
}

export interface CreateStandingOrderDto {
  customerId: string;
  name: string;
  daysOfWeek: number[];
  notes?: string;
  items: { productId: string; qty: number; notes?: string }[];
}

export interface UpdateStandingOrderDto {
  name?: string;
  daysOfWeek?: number[];
  isActive?: boolean;
  notes?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyStandingOrders(customerId?: string) {
  return useQuery<{ data: StandingOrder[]; meta: any }>({
    queryKey: ["order-templates", "mine", customerId ?? "all"],
    queryFn: () =>
      apiClient
        .get("/order-templates", { params: customerId ? { customerId } : undefined })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyStandingOrder(id: string) {
  return useQuery<StandingOrder>({
    queryKey: ["order-templates", id],
    queryFn: () => apiClient.get(`/order-templates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// Returns templates due today (uses JS day-of-week, 0=Sun)
export function useTodayStandingOrders(customerId?: string) {
  const today = new Date().getDay(); // 0-6
  return useQuery<{ data: StandingOrder[]; meta: any }>({
    queryKey: ["order-templates", "today", customerId ?? "all"],
    queryFn: async () => {
      const res = await apiClient
        .get("/order-templates", { params: customerId ? { customerId } : undefined })
        .then((r) => r.data);
      const todayTemplates = (res.data as StandingOrder[]).filter(
        (t) => t.isActive && t.daysOfWeek.includes(today),
      );
      return { data: todayTemplates, meta: { total: todayTemplates.length } };
    },
    staleTime: 60_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useToggleStandingOrder() {
  const qc = useQueryClient();
  return useMutation<StandingOrder, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      apiClient.patch(`/order-templates/${id}`, { isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useCreateStandingOrder() {
  const qc = useQueryClient();
  return useMutation<StandingOrder, Error, CreateStandingOrderDto>({
    mutationFn: (dto) => apiClient.post("/order-templates", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useUpdateStandingOrder() {
  const qc = useQueryClient();
  return useMutation<StandingOrder, Error, { id: string; dto: UpdateStandingOrderDto }>({
    mutationFn: ({ id, dto }) => apiClient.patch(`/order-templates/${id}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useAddTemplateItem() {
  const qc = useQueryClient();
  return useMutation<
    TemplateItem,
    Error,
    { templateId: string; productId: string; qty: number; notes?: string }
  >({
    mutationFn: ({ templateId, productId, qty, notes }) =>
      apiClient
        .post(`/order-templates/${templateId}/items`, { productId, qty, notes })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useRemoveTemplateItem() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { templateId: string; itemId: string }>({
    mutationFn: ({ templateId, itemId }) =>
      apiClient.delete(`/order-templates/${templateId}/items/${itemId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useGenerateOrder() {
  const qc = useQueryClient();
  return useMutation<any, Error, string>({
    mutationFn: (templateId) =>
      apiClient.post(`/order-templates/${templateId}/generate`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-templates"] });
    },
  });
}
