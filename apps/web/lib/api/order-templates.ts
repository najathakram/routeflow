import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { OrderTemplateItem } from "@routeflow/types";
export type { OrderTemplateItem } from "@routeflow/types";

export interface OrderTemplate {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  name: string;
  isActive: boolean;
  daysOfWeek: number[];
  notes?: string;
  items: OrderTemplateItem[];
  createdAt: string;
  updatedAt: string;
}

export function useOrderTemplates(customerId?: string) {
  return useQuery<OrderTemplate[]>({
    queryKey: ["order-templates", customerId],
    queryFn: () =>
      apiClient
        .get("/order-templates", { params: customerId ? { customerId } : undefined })
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data.data ?? []))),
    enabled: customerId !== undefined ? !!customerId : true,
  });
}

export function useOrderTemplate(id: string) {
  return useQuery<OrderTemplate>({
    queryKey: ["order-templates", id],
    queryFn: () => apiClient.get(`/order-templates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<
    OrderTemplate,
    Error,
    {
      customerId: string;
      name: string;
      daysOfWeek: number[];
      notes?: string;
      items: { productId: string; qty: number; notes?: string }[];
    }
  >({
    mutationFn: (dto) => apiClient.post("/order-templates", dto).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["order-templates", data.customerId] });
      qc.invalidateQueries({ queryKey: ["order-templates"] });
    },
  });
}

export function useUpdateOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<
    OrderTemplate,
    Error,
    {
      id: string;
      name?: string;
      daysOfWeek?: number[];
      isActive?: boolean;
      notes?: string;
      items?: { productId: string; qty: number; notes?: string }[];
    }
  >({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/order-templates/${id}`, dto).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["order-templates", data.id] });
      qc.invalidateQueries({ queryKey: ["order-templates", data.customerId] });
    },
  });
}

export function useDeleteOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { id: string; customerId: string }>({
    mutationFn: ({ id }) => apiClient.delete(`/order-templates/${id}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["order-templates", vars.customerId] });
      qc.invalidateQueries({ queryKey: ["order-templates"] });
    },
  });
}

export function useAddTemplateItem() {
  const qc = useQueryClient();
  return useMutation<
    OrderTemplateItem,
    Error,
    { templateId: string; productId: string; qty: number; notes?: string }
  >({
    mutationFn: ({ templateId, ...dto }) =>
      apiClient.post(`/order-templates/${templateId}/items`, dto).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["order-templates", vars.templateId] });
    },
  });
}

export function useRemoveTemplateItem() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { templateId: string; itemId: string }>({
    mutationFn: ({ templateId, itemId }) =>
      apiClient.delete(`/order-templates/${templateId}/items/${itemId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["order-templates", vars.templateId] });
    },
  });
}

export function useGenerateTemplateOrder() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (templateId) =>
      apiClient.post(`/order-templates/${templateId}/generate`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}
