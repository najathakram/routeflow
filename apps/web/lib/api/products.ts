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

/**
 * Promote multiple existing standalone products to variants of a single
 * parent product. Used by the "Group as variants of…" bulk action so the
 * operator can fix up a catalog where each flavor was entered as its own
 * standalone product, without re-creating anything.
 *
 * No dedicated bulk endpoint on the API — issues parallel PATCH /products/:id
 * calls and reports per-item success/failure to the caller.
 */
export interface BulkAssignParentResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
}

export function useBulkAssignParent() {
  const qc = useQueryClient();
  return useMutation<
    BulkAssignParentResult,
    Error,
    {
      parentProductId: string;
      assignments: Array<{ id: string; variantName: string }>;
    }
  >({
    mutationFn: async ({ parentProductId, assignments }) => {
      const settled = await Promise.allSettled(
        assignments.map((a) =>
          apiClient
            .patch(`/products/${a.id}`, {
              parentProductId,
              variantName: a.variantName,
            })
            .then(() => a.id),
        ),
      );
      const succeeded: string[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      settled.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          succeeded.push(r.value);
        } else {
          const e = r.reason as { response?: { data?: { message?: string } } };
          failed.push({
            id: assignments[idx].id,
            reason: e?.response?.data?.message ?? "Update failed",
          });
        }
      });
      return { succeeded, failed };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export interface UploadProductImagesArgs {
  files: File[];
  /** Per-file focal point (0..100). If omitted, defaults to centre. */
  focals?: Array<{ x: number; y: number }>;
}

export function useUploadProductImages(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      args: UploadProductImagesArgs,
    ): Promise<{ uploaded: { key: string; url: string }[] }> => {
      const { files, focals } = args;
      const form = new FormData();
      files.forEach((f, i) => {
        form.append("files", f);
        const focal = focals?.[i];
        if (focal) {
          form.append("focalX", String(focal.x));
          form.append("focalY", String(focal.y));
        }
      });
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
