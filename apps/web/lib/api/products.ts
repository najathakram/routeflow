import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export function useProducts(
  params?: {
    search?: string;
    category?: string;
    isActive?: boolean;
    stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
    page?: number;
    limit?: number;
    includeVariants?: boolean;
  },
  options?: { refetchInterval?: number },
) {
  return useQuery({
    queryKey: ["products", params],
    queryFn: () => apiClient.get("/products", { params }).then((r) => r.data),
    ...options,
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

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/products/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export type CostingMethod = "FIFO" | "LIFO" | "AVCO" | "STANDARD";

export interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  isActive: boolean;
  currentStock: number;
  averageCost?: string;
  description?: string;
  thumbnailUrl?: string | null;
  costingMethod?: CostingMethod;
  standardCost?: string | number;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  variantName?: string | null;
  variants?: ApiProduct[];
  parent?: ApiProduct | null;
}

export interface ZohoImportItem {
  name: string;
  sku?: string;
  barcode?: string;
  unit: string;
  pricePerUnit: string;
  category?: string;
  description?: string;
  isActive?: boolean;
  currentStock?: string;
  averageCost?: string;
  reorderPoint?: number;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: Array<{ row: number; name: string; reason: string }>;
}

export function useImportProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ZohoImportItem[]): Promise<ImportResult> =>
      apiClient.post("/products/import", { items }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useClearAllProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<{ deleted: number }> =>
      apiClient.delete("/products/clear-all").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useBulkDeleteProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]): Promise<{ deleted: number }> =>
      apiClient.delete("/products/bulk", { data: { ids } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useUploadProductImages(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]): Promise<{ uploaded: { key: string; url: string }[] }> => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      // Do NOT set Content-Type manually — Axios auto-sets multipart/form-data
      // WITH the correct boundary when it detects a FormData body.
      return apiClient.post(`/products/${id}/images`, form).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products", id] }),
  });
}

export function useDeleteProductImage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string): Promise<void> =>
      apiClient.delete(`/products/${id}/images`, { data: { key } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products", id] }),
  });
}

/** Plain async helper — upload images to a product (use after creation to get the ID first). */
export async function uploadProductImages(
  id: string,
  files: File[],
): Promise<void> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  // Do NOT set Content-Type manually — Axios auto-sets multipart/form-data
  // WITH the correct boundary when it detects a FormData body.
  await apiClient.post(`/products/${id}/images`, form);
}
