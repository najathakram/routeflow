import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ImageUploadFile } from "../product-image";
import { nextProductPage, type PaginationMeta } from "../product-search-params";

/** Rows per page for the catalogue pickers. */
export const PRODUCT_PAGE_SIZE = 50;

export function useProducts(
  params?: {
    search?: string;
    category?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  },
  // Mirrors apps/web/lib/api/products.ts so a picker can gate its fetch while
  // closed.
  options?: { enabled?: boolean; staleTime?: number },
) {
  // isActive was sent but NOT keyed, so a caller passing `false` silently got
  // actives from the cache. Folding it into one object fixes both.
  const query = { isActive: true, ...params };
  return useQuery({
    queryKey: ["products", query],
    queryFn: () => apiClient.get("/products", { params: query }).then((r) => r.data),
    staleTime: options?.staleTime ?? 5 * 60 * 1000,
    // Every caller of this hook is a search-driven picker. Without this, each
    // keystroke mints a new query key, `data` goes undefined, and the list
    // blanks to a spinner — which is what "suggestions do not appear" looked
    // like. Baked in rather than opt-in so a new call site can't forget it.
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Paged catalogue for the sale builders. Replaces the `limit: 0` fetch-all,
 * which asked the server for up to 10,000 rows and shipped megabytes to a
 * phone before the first row could render.
 *
 * Key stays under ["products"] so the existing mutation invalidations reach it.
 */
export function useProductsInfinite(
  params?: { search?: string; scanCode?: string; category?: string; limit?: number },
  options?: { enabled?: boolean },
) {
  const limit = params?.limit ?? PRODUCT_PAGE_SIZE;
  const query = { ...params, limit, isActive: true };
  return useInfiniteQuery({
    queryKey: ["products", "infinite", query],
    queryFn: ({ pageParam }) =>
      apiClient
        .get("/products", { params: { ...query, page: pageParam } })
        .then((r) => r.data as { data: any[]; meta: PaginationMeta }),
    initialPageParam: 1,
    getNextPageParam: (last) => nextProductPage(last?.meta),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
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
  /** Link this product as a variant of an existing standalone product. */
  parentProductId?: string;
  /** Flavor/variety label; required when parentProductId is set. */
  variantName?: string;
  /** Regulated section tag. Create: omit when unset. Edit: send `null` to clear. */
  trackedCategoryId?: string | null;
  /** Regulated subcategory tag (must belong to trackedCategoryId). Same null-to-clear rule. */
  trackedSubcategoryId?: string | null;
  /**
   * Regulatory reporting config (mirrors apps/web/lib/api/products.ts). The vocabulary
   * is validated service-side against the section's reportTemplate
   * (apps/api/src/regulated/template-registry.ts). Same null-to-clear rule as above.
   */
  regItemType?: string | null;
  /** Case/carton UoM — opts the product into case-level report bucketing when sold by the box. */
  regUomCase?: string | null;
  /** Loose/unit UoM. */
  regUomUnit?: string | null;
}

/**
 * The product row POST /products returns — enough to drop straight into an
 * order/invoice cart (id, price, box size, variant linkage) without a refetch.
 * `parent` isn't populated on create, so compose display names via
 * `displayProductName(product, loadedProducts)` which resolves parentProductId.
 */
export interface CreatedProduct {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  unit?: string;
  category?: string | null;
  pricePerUnit: number | string;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  variantName?: string | null;
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
  return useMutation<CreatedProduct, Error, CreateProductDto>({
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
