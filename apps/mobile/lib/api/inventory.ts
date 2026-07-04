import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StockItem {
  productId: string;
  productName: string;
  unit: string;
  currentStock: number;
  reorderPoint?: number;
  reorderQty?: number;
  /** Effective unit cost (standard cost for STANDARD products, else weighted average); null = no cost set */
  averageCost: number | null;
  totalValue: number | null;
  costingMethod?: string;
}

export interface StockAdjustmentDto {
  productId: string;
  quantity: number; // positive = add, negative = remove
  notes?: string;
  reference?: string;
}

export interface StockPurchaseDto {
  productId: string;
  quantity: number;
  unitCost: number;
  supplierId?: string;
  reference?: string;
  notes?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useStockOverview() {
  return useQuery<StockItem[]>({
    queryKey: ["inventory", "overview"],
    queryFn: () =>
      apiClient.get("/inventory/overview").then((r) =>
        (r.data as any[]).map((p) => ({
          productId: p.id,
          productName: p.name,
          unit: p.unit ?? "",
          currentStock: p.currentStock ?? 0,
          reorderPoint: p.reorderPoint ?? undefined,
          reorderQty: p.reorderQty ?? undefined,
          averageCost: p.averageCost ?? null,
          totalValue: p.totalValue ?? null,
          costingMethod: p.costingMethod ?? undefined,
        })),
      ),
    staleTime: 30_000,
  });
}

// ─── Cost basis & valuation ───────────────────────────────────────────────────

export interface InventoryValuation {
  totalValue: number;
  productCount: number;
  missingCostCount: number;
  missingCostProducts: { id: string; name: string }[];
}

export function useInventoryValuation() {
  return useQuery<InventoryValuation>({
    queryKey: ["inventory", "valuation"],
    queryFn: () => apiClient.get("/inventory/valuation").then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useSetCostBasis() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { productId: string; unitCost: number; notes?: string; applyToLots?: boolean }
  >({
    mutationFn: ({ productId, ...data }) =>
      apiClient.patch(`/inventory/products/${productId}/cost-basis`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useBulkSetCostBasis() {
  const qc = useQueryClient();
  return useMutation<
    { updated: number },
    Error,
    { items: { productId: string; unitCost: number }[]; notes?: string; applyToLots?: boolean }
  >({
    mutationFn: (data) => apiClient.post("/inventory/cost-basis/bulk", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useRecordAdjustment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, StockAdjustmentDto>({
    mutationFn: (dto) => apiClient.post("/inventory/movements/adjustment", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory"] }),
  });
}

export function useRecordPurchase() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, StockPurchaseDto>({
    mutationFn: (dto) => apiClient.post("/inventory/movements/purchase", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory"] }),
  });
}

// ─── Movements / history ──────────────────────────────────────────────────────

export type MovementType =
  | "PURCHASE"
  | "SALE"
  | "ADJUSTMENT"
  | "RETURN"
  | "WRITE_OFF"
  | "COST_BASIS";

export interface InventoryMovement {
  id: string;
  productId: string;
  productName?: string;
  type: MovementType;
  quantity: number;
  unitCost?: number;
  reference?: string;
  notes?: string;
  createdAt: string;
}

export function useInventoryMovements(params?: {
  productId?: string;
  type?: MovementType;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: InventoryMovement[]; meta: any }>({
    queryKey: ["inventory", "movements", params],
    queryFn: () =>
      apiClient
        .get("/inventory/movements", { params })
        .then((r) => r.data)
        .catch(() => ({ data: [], meta: { total: 0 } })),
    staleTime: 30_000,
  });
}
