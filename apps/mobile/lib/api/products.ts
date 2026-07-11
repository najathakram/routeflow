import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ImageUploadFile } from "../product-image";

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

/** Distinct tenant categories for autocomplete (mirrors web useProductCategories). */
export function useProductCategories() {
  return useQuery<string[]>({
    queryKey: ["products", "categories"],
    queryFn: () => apiClient.get("/products/categories").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
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
  /** Customer tier prices (tier 1 = pricePerUnit); blank/omitted inherits tier 1. */
  priceTier2?: number;
  priceTier3?: number;
  priceTier4?: number;
  priceTier5?: number;
  standardCost?: number;
  currentStock?: number;
  isActive?: boolean;
  /** Requires the tenant's "tobacco_dealer" addon to set true. */
  isTobacco?: boolean;
  /**
   * Link this product as a VARIANT (child) of another standalone product. A
   * variant is a full Product row with its own absolute price/tiers — there is
   * no delta pricing. When set, `name` carries the flavor/variety (mirrors web,
   * where the "Flavor / Variety" field replaces "Name") and `variantName` is the
   * same label. Uniqueness of `name` is scoped to siblings of the same parent.
   */
  parentProductId?: string;
  variantName?: string;
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

/**
 * Upload one or more product photos — `POST /products/:id/images`, multipart,
 * field name `files` (the API's FilesInterceptor). Focal point is omitted
 * (centered) — the server treats "no focalX/Y" as centre, no suffix. Mirrors
 * the vendor-bill scan multipart pattern (RN file object, explicit content-type).
 */
export function useUploadProductImages() {
  const qc = useQueryClient();
  return useMutation<{ uploaded: unknown[] }, Error, { id: string; files: ImageUploadFile[] }>({
    mutationFn: ({ id, files }) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f as unknown as Blob));
      return apiClient
        .post(`/products/${id}/images`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60_000,
        })
        .then((r) => r.data);
    },
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["products", id] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

/** Remove one product image by its storage key — `DELETE /products/:id/images` body `{key}`. */
export function useDeleteProductImage() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; key: string }>({
    mutationFn: ({ id, key }) =>
      apiClient.delete(`/products/${id}/images`, { data: { key } }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["products", id] });
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
