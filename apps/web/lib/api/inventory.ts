import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Stock overview ───────────────────────────────────────────────────────────

export function useStockOverview() {
  return useQuery({
    queryKey: ["inventory", "overview"],
    queryFn: () => apiClient.get("/inventory/overview").then((r) => r.data),
  });
}

// ─── Movements ────────────────────────────────────────────────────────────────

export function useStockMovements(params?: {
  productId?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ["inventory", "movements", params],
    queryFn: () => apiClient.get("/inventory/movements", { params }).then((r) => r.data),
  });
}

export function useRecordPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/inventory/movements/purchase", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useRecordAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/inventory/movements/adjustment", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Suppliers ────────────────────────────────────────────────────────────────

export function useSuppliers() {
  return useQuery({
    queryKey: ["inventory", "suppliers"],
    queryFn: () => apiClient.get("/inventory/suppliers").then((r) => r.data),
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/inventory/suppliers", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "suppliers"] }),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/inventory/suppliers/${id}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "suppliers"] }),
  });
}

// ─── Purchase Orders ──────────────────────────────────────────────────────────

export function usePurchaseOrders(params?: {
  status?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ["inventory", "purchase-orders", params],
    queryFn: () => apiClient.get("/inventory/purchase-orders", { params }).then((r) => r.data),
  });
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: ["inventory", "purchase-orders", id],
    queryFn: () => apiClient.get(`/inventory/purchase-orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/inventory/purchase-orders", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] }),
  });
}

export function useSendPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post(`/inventory/purchase-orders/${id}/send`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] }),
  });
}

export function useReceivePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, items }: { id: string; items: { id: string; receivedQty: number }[] }) =>
      apiClient.post(`/inventory/purchase-orders/${id}/receive`, { items }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useClosePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post(`/inventory/purchase-orders/${id}/close`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] }),
  });
}

// ─── Forecasting ──────────────────────────────────────────────────────────────

export function useForecasting() {
  return useQuery({
    queryKey: ["inventory", "forecasting"],
    queryFn: () => apiClient.get("/inventory/forecasting").then((r) => r.data),
  });
}

export function useUpdateReorderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      productId,
      reorderPoint,
      reorderQty,
    }: {
      productId: string;
      reorderPoint: number;
      reorderQty: number;
    }) =>
      apiClient
        .patch(`/inventory/products/${productId}/reorder-settings`, { reorderPoint, reorderQty })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "forecasting"] }),
  });
}
