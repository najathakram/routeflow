import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ProductKind } from "@routeflow/types";
import type { LocalErrorToastOption } from "@/lib/local-error-toast";

export function useProducts(
  params?: {
    search?: string;
    /** Scanned code — server expands normalizeScanCode candidates into the
     *  contains-search so the lookup is decoder-independent. Ignored when
     *  `search` is also set. */
    scanCode?: string;
    category?: string;
    isActive?: boolean;
    stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
    /** Regulated-section filter: "any" (any regulated), "none" (non-regulated), or a section id. */
    section?: string;
    /** `false` lists only products hidden from the buyer portal. */
    portalVisible?: boolean;
    page?: number;
    limit?: number;
    includeVariants?: boolean;
  },
  options?: { refetchInterval?: number; enabled?: boolean },
) {
  return useQuery({
    queryKey: ["products", params],
    queryFn: () => apiClient.get("/products", { params }).then((r) => r.data),
    ...options,
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

/** Distinct tenant categories for autocomplete. Invalidated with the ["products"] prefix. */
export function useProductCategories() {
  return useQuery<string[]>({
    queryKey: ["products", "categories"],
    queryFn: () => apiClient.get("/products/categories").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
}

/** Invalidate every query whose data depends on the set of products. */
export function invalidateProductSet(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["products"] });
  // Inventory overview + valuation are derived from products but keyed
  // separately — refresh them so a newly created/deleted product shows up
  // in the stock table, valuation card, and modal pickers immediately.
  qc.invalidateQueries({ queryKey: ["inventory"] });
}

export function useCreateProduct(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/products", data).then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/products/${id}`, data).then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
  });
}

/**
 * Reactivate a product (WS7): `PATCH /products/:id { isActive: true }`. The 409 refusal names the
 * ACTIVE holders of its codes/name (see `getReactivationRefusal`); resending with `deactivateHolderIds`
 * = exactly those ids deactivates them and reactivates this product in one transaction.
 */
export function useReactivateProduct() {
  const qc = useQueryClient();
  return useMutation({
    // The flow renders its own fixed-sentence error UI (dialog / toast): opt out of the global
    // handler's raw `data.message` toast (lib/mutation-error-toast.ts).
    meta: { localErrorToast: true },
    mutationFn: ({
      id,
      deactivateHolderIds,
      newCodes,
    }: {
      id: string;
      deactivateHolderIds?: string[];
      /** Reactivate with replacement codes instead of deactivating the holders. */
      newCodes?: { sku?: string; unitSku?: string; barcode?: string };
    }) =>
      apiClient
        .patch(`/products/${id}`, {
          isActive: true,
          ...(deactivateHolderIds?.length ? { deactivateHolderIds } : {}),
          ...(newCodes ?? {}),
        })
        .then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
  });
}

/**
 * Deactivate a product (`PATCH { isActive: false }`). Its 409 CODES_CHANGED gets a fixed sentence from
 * the caller (`deactivateFailureToast`), so the global raw-message toast is opted out.
 */
export function useDeactivateProduct() {
  const qc = useQueryClient();
  return useMutation({
    meta: { localErrorToast: true },
    // `confirmCascade` is only ever sent after the operator confirmed the 409 FAMILY_HAS_ACTIVE_VARIANTS prompt.
    mutationFn: (arg: string | { id: string; confirmCascade?: boolean }) => {
      const { id, confirmCascade } = typeof arg === "string" ? { id: arg } : arg;
      return apiClient
        .patch(`/products/${id}`, {
          isActive: false,
          ...(confirmCascade ? { confirmCascade } : {}),
        })
        .then((r) => r.data);
    },
    onSuccess: () => invalidateProductSet(qc),
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    // Its only caller toasts a fixed sentence itself (deactivateFailureToast).
    meta: { localErrorToast: true },
    mutationFn: (arg: string | { id: string; confirmCascade?: boolean }) => {
      const { id, confirmCascade } = typeof arg === "string" ? { id: arg } : arg;
      return apiClient
        .delete(
          `/products/${id}`,
          confirmCascade ? { params: { confirmCascade: "true" } } : undefined,
        )
        .then((r) => r.data);
    },
    onSuccess: () => invalidateProductSet(qc),
  });
}

export type CostingMethod = "FIFO" | "LIFO" | "AVCO" | "STANDARD";

export interface ApiProduct {
  id: string;
  /** STANDARD | FAMILY | VARIANT | RECIPE (WS8): a FAMILY is a non-stocked, non-sellable container. */
  kind?: ProductKind;
  name: string;
  sku?: string;
  /** Optional retail-unit (inner piece) code; null/absent ⇒ unit shares the case `sku`. */
  unitSku?: string | null;
  barcode?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  /**
   * Suggested retail price, per PIECE (the retail selling unit) even when this
   * product sells wholesale by the box. Display-only — never feed into money
   * math. null/absent = no MSRP set (render blank, never $0.00).
   */
  msrp?: string | null;
  isActive: boolean;
  currentStock: number;
  averageCost?: string;
  description?: string;
  thumbnailUrl?: string | null;
  costingMethod?: CostingMethod;
  standardCost?: string | number;
  unitsPerBox?: number | null;
  /**
   * Regulatory reporting config (template-agnostic; vocabulary comes from the
   * section's reportTemplate — see `useRegulatedTemplates`). `regUomCase` is
   * optional and opts the product into case-level bucketing when sold by the
   * box; leaving it null reports quantities unconverted.
   */
  regItemType?: string | null;
  regUomCase?: string | null;
  regUomUnit?: string | null;
  parentProductId?: string | null;
  variantName?: string | null;
  variants?: ApiProduct[];
  parent?: ApiProduct | null;
  /** Buyer merchandising flags (P5-01). */
  isFeatured?: boolean;
  isNew?: boolean;
  isDeal?: boolean;
  /**
   * Regulated section + subcategory tags (Phase 4). `findOne` embeds the related
   * objects; list endpoints may return only the ids. The section carries the
   * compliance semantics; the subcategory is classification-only.
   */
  trackedCategoryId?: string | null;
  trackedCategory?: { id: string; name: string } | null;
  trackedSubcategoryId?: string | null;
  trackedSubcategory?: { id: string; name: string; trackedCategoryId: string } | null;
  /** Number of buyers waiting on a restock notification (P5-03). */
  stockAlertCount?: number;
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

/** Matches the server's @ArrayMaxSize on DELETE /products/bulk (F9-009). */
const BULK_DELETE_CHUNK = 500;

/**
 * DELETE /products/bulk classifies each id (R1): reference-free products are
 * hard-deleted, products with history are deactivated, and products with active
 * order items are skipped with a per-product reason built from the product name.
 */
export interface BulkDeleteProductsResult {
  deleted: number;
  softDeleted: number;
  skipped: Array<{ id: string; code?: string; reason?: string }>;
}

export function useBulkDeleteProducts() {
  const qc = useQueryClient();
  return useMutation({
    // Its only caller toasts a fixed sentence itself (deactivateFailureToast).
    meta: { localErrorToast: true },
    // The server caps each request at 500 ids (F9-009 DTO). Chunk large selections
    // ("Show all → Select all → Delete" on a >500-product tenant) into sequential
    // batches so a wholesale delete still succeeds instead of 400-ing on the cap.
    // Every chunk's counts are summed and its `skipped` entries concatenated, so
    // the caller sees one merged result for the whole selection.
    mutationFn: async (ids: string[]): Promise<BulkDeleteProductsResult> => {
      let deleted = 0;
      let softDeleted = 0;
      const skipped: BulkDeleteProductsResult["skipped"] = [];
      for (let i = 0; i < ids.length; i += BULK_DELETE_CHUNK) {
        const chunk = ids.slice(i, i + BULK_DELETE_CHUNK);
        const r = await apiClient.delete("/products/bulk", { data: { ids: chunk } });
        deleted += Number(r.data?.deleted ?? 0);
        softDeleted += Number(r.data?.softDeleted ?? 0);
        if (Array.isArray(r.data?.skipped)) skipped.push(...r.data.skipped);
      }
      return { deleted, softDeleted, skipped };
    },
    onSuccess: () => invalidateProductSet(qc),
  });
}

/**
 * Promote multiple existing standalone products to variants of a single
 * parent product. Used by the "Group as variants of…" bulk action so the
 * operator can fix up a catalog where each flavor was entered as its own
 * standalone product, without re-creating anything.
 *
 * One POST /products/bulk-assign-parent call — the API loops the updates
 * server-side and reports per-item success/failure back.
 */
export interface BulkAssignParentResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
  /** H2: per product that kept labels it carried through its old parent (absent from older servers). */
  keptLabels?: Array<{ id: string; labels: string[] }>;
}

export function useBulkAssignParent(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<
    BulkAssignParentResult,
    Error,
    {
      parentProductId: string;
      assignments: Array<{ id: string; variantName: string }>;
    }
  >({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: ({ parentProductId, assignments }) =>
      apiClient
        .post("/products/bulk-assign-parent", { parentProductId, assignments })
        .then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
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
export async function uploadProductImages(id: string, files: File[]): Promise<void> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  // Do NOT set Content-Type manually — Axios auto-sets multipart/form-data
  // WITH the correct boundary when it detects a FormData body.
  await apiClient.post(`/products/${id}/images`, form);
}
