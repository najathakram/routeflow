import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export function useProducts(params?: {
  search?: string;
  category?: string;
  lowStock?: boolean;
  isActive?: boolean;
  page?: number;
}) {
  return useQuery({
    queryKey: ["products", params],
    queryFn: () => apiClient.get("/products", { params }).then((r) => r.data),
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: ["products", id],
    queryFn: () => apiClient.get(`/products/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/products", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/products/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["products", vars.id] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useClearProductOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.patch(`/products/${id}/override`).then((r) => r.data),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ["products", id] }),
  });
}
