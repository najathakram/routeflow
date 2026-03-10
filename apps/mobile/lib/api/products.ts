import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export function useProducts(params?: { search?: string; category?: string; isActive?: boolean }) {
  return useQuery({
    queryKey: ["products", params],
    queryFn: () =>
      apiClient.get("/products", { params: { ...params, isActive: true } }).then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: ["products", id],
    queryFn: () => apiClient.get(`/products/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}
