import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { invalidateSupplierLists } from "./suppliers";
import type {
  InventoryValuation,
  ProductCountRequest,
  ProductCountResult,
  RecomputeCostsResult,
} from "@routeflow/types";
export type { InventoryValuation, RecomputeCostsResult } from "@routeflow/types";

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

/**
 * Payload for `POST /inventory/movements/purchase` (InventoryService.recordPurchase).
 * `quantity` is base units (pieces) — omit it and send `boxes`/`pieces` instead
 * for a boxed product; the server resolves the received piece total from the
 * split and ignores a bare `quantity` when either is present. `unitCost` is
 * quoted per SELLING UNIT: a box when `boxes`/`pieces` is sent, a piece
 * otherwise — the server converts to per-piece before AVCO math.
 */
export interface RecordPurchaseInput {
  productId: string;
  supplierId?: string;
  quantity?: number;
  boxes?: number;
  pieces?: number;
  unitCost: number;
  reference?: string;
  notes?: string;
  effectiveDate?: string;
}

export function useRecordPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: RecordPurchaseInput) =>
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

/**
 * SA-828 (row 657): set the stock to a count, or adjust it by a delta, in one of the product's units.
 * The modal renders the refusal itself (`localErrorToast`), so the app-wide toast stays quiet.
 */
export function useProductCount(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { localErrorToast: true },
    mutationFn: (body: ProductCountRequest) =>
      apiClient
        .post<ProductCountResult>(`/inventory/products/${productId}/count`, body)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Cost basis & valuation ───────────────────────────────────────────────────

export function useInventoryValuation() {
  return useQuery<InventoryValuation>({
    queryKey: ["inventory", "valuation"],
    queryFn: () => apiClient.get("/inventory/valuation").then((r) => r.data),
  });
}

export function useSetCostBasis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      productId,
      ...data
    }: {
      productId: string;
      unitCost: number;
      notes?: string;
      applyToLots?: boolean;
    }) => apiClient.patch(`/inventory/products/${productId}/cost-basis`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useBulkSetCostBasis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      items: { productId: string; unitCost: number }[];
      notes?: string;
      applyToLots?: boolean;
    }) => apiClient.post("/inventory/cost-basis/bulk", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useRecomputeCosts() {
  const qc = useQueryClient();
  return useMutation<RecomputeCostsResult, unknown, { productIds?: string[]; dryRun?: boolean }>({
    mutationFn: (data) => apiClient.post("/inventory/recompute-costs", data).then((r) => r.data),
    onSuccess: (_result, variables) => {
      if (!variables.dryRun) {
        qc.invalidateQueries({ queryKey: ["inventory"] });
        qc.invalidateQueries({ queryKey: ["products"] });
      }
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
    onSuccess: () => invalidateSupplierLists(qc),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/inventory/suppliers/${id}`, data).then((r) => r.data),
    onSuccess: () => invalidateSupplierLists(qc),
  });
}

// ─── Purchase Orders ──────────────────────────────────────────────────────────

export function usePurchaseOrders(
  params?: {
    status?: string;
    supplierId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  },
  opts?: { keepPrevious?: boolean },
) {
  return useQuery({
    queryKey: ["inventory", "purchase-orders", params],
    queryFn: () => apiClient.get("/inventory/purchase-orders", { params }).then((r) => r.data),
    // a pager keeps the previous page on screen while the next one loads
    ...(opts?.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: ["inventory", "purchase-orders", id],
    queryFn: () => apiClient.get(`/inventory/purchase-orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/**
 * A PO line for `POST /inventory/purchase-orders`. `qty` is always a base-unit
 * (piece) total and `unitCost` always per PIECE — for a boxed product the
 * caller (CreatePOModal's `resolvePOLine`) converts the operator's
 * Boxes+Pieces and Cost-per-Box entry down to this shape before sending, so
 * `qty * unitCost` here matches what `qtyReceived`/`item.unitCost` mean later
 * at receive time (no server-side box conversion exists for PO creation).
 */
export interface PurchaseOrderItemInput {
  productId: string;
  /** Per-piece line: pieces and a per-piece cost. */
  qty?: number;
  unitCost?: number;
  /**
   * Per-case line (a boxed product): the ENTERED figures. The server computes the quantity, the per-piece
   * cost and the exact total (roundMoney(caseCost x (cases + loosePieces / packSize))) and ignores any client
   * total or per-piece figure; `packSize` is stored as the denomination.
   */
  packSize?: number;
  caseCost?: number;
  cases?: number;
  loosePieces?: number;
}

export interface CreatePurchaseOrderInput {
  supplierId?: string;
  items: PurchaseOrderItemInput[];
  expectedDate?: string;
  notes?: string;
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePurchaseOrderInput) =>
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

/**
 * `receivedQty` is always a base-unit (piece) total. For a boxed line the
 * caller (ReceivePOModal) converts the operator's Boxes+Pieces entry to this
 * total client-side; the API also accepts `boxes`/`pieces` and resolves the
 * same total server-side. Either way the cost basis is untouched — the PO
 * item's `unitCost` is per piece from creation (CreatePurchaseOrderInput) and
 * the receive shape never re-scales it.
 *
 * It must not exceed the line's outstanding quantity (`qtyOrdered -
 * qtyReceived`): the API rejects an over-receipt rather than silently clamping
 * it down, which on a box-denominated legacy PO would under-receive by
 * unitsPerBox and close the PO for good.
 */
export interface ReceivePurchaseOrderItemInput {
  id: string;
  receivedQty: number;
}

export function useReceivePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, items }: { id: string; items: ReceivePurchaseOrderItemInput[] }) =>
      apiClient.post(`/inventory/purchase-orders/${id}/receive`, { items }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/**
 * One line of `PATCH /inventory/purchase-orders/:id`. Like a create line, `qtyOrdered`
 * is base-unit (piece) and `unitCost` per PIECE. `id` keeps an existing line (a line
 * missing from the array is REMOVED — `items` is a full replacement); no `id` = new.
 */
export interface UpdatePurchaseOrderItemInput {
  id?: string;
  productId: string;
  /** Per-piece line. */
  qtyOrdered?: number;
  unitCost?: number;
  /** Per-case line (see PurchaseOrderItemInput): packSize + caseCost + cases (+ loosePieces). */
  caseCost?: number;
  cases?: number;
  loosePieces?: number;
  sku?: string | null;
  packSize?: number | null;
}

export interface UpdatePurchaseOrderInput {
  supplierId?: string;
  expectedDate?: string | null;
  notes?: string | null;
  items?: UpdatePurchaseOrderItemInput[];
  /**
   * Required by the API when `items` (or the supplier) changes a PARTIAL/RECEIVED order:
   * `true` restates the COST (and supplier) of what was already received in stock and
   * average cost; `false` changes the document only. Never changes a received quantity.
   */
  reapplyInventory?: boolean;
}

export function useUpdatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdatePurchaseOrderInput & { id: string }) =>
      apiClient.patch(`/inventory/purchase-orders/${id}`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] });
      // a re-apply moves stock + average cost, so the stock overview goes stale too
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
