import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export function useProducts(params?: {
  search?: string;
  category?: string;
  isActive?: boolean;
  limit?: number;
}) {
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

export function useProductByBarcode(barcode: string | null) {
  return useQuery({
    queryKey: ["products", "barcode", barcode],
    queryFn: () => apiClient.get(`/products/barcode/${barcode}`).then((r) => r.data),
    enabled: !!barcode,
    retry: false,
  });
}

export interface CreateProductDto {
  name: string;
  sku?: string;
  barcode?: string;
  description?: string;
  category?: string;
  unit?: string;
  /**
   * Loose pieces per box. When present and > 1, `pricePerUnit` is the BOX
   * price; loose pieces are prorated. Drives the boxes/pieces editor in
   * order screens.
   */
  unitsPerBox?: number;
  pricePerUnit: number;
  standardCost?: number;
  currentStock?: number;
  isActive?: boolean;
}

export function useUpdateReorderSettings() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { productId: string; reorderPoint?: number; reorderQty?: number }
  >({
    mutationFn: ({ productId, ...dto }) =>
      apiClient.patch(`/inventory/products/${productId}/reorder-settings`, dto).then((r) => r.data),
    onSuccess: (_, { productId }) => {
      qc.invalidateQueries({ queryKey: ["products", productId] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, CreateProductDto>({
    mutationFn: (dto) => apiClient.post("/products", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, { id: string } & Partial<CreateProductDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/products/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products", id] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/products/${id}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

export function useAdjustProductStock() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { productId: string; quantity: number; notes?: string; reference?: string }
  >({
    mutationFn: (dto) => apiClient.post("/inventory/movements/adjustment", dto).then((r) => r.data),
    onSuccess: (_, { productId }) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products", productId] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
