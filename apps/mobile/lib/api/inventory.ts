import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StockItem {
  productId: string;
  productName: string;
  unit: string;
  currentStock: number;
  reorderPoint?: number;
  reorderQty?: number;
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
    queryKey: ['inventory', 'overview'],
    queryFn: () =>
      apiClient.get('/inventory/overview').then((r) =>
        (r.data as any[]).map((p) => ({
          productId: p.id,
          productName: p.name,
          unit: p.unit ?? '',
          currentStock: p.currentStock ?? 0,
          reorderPoint: p.reorderPoint ?? undefined,
          reorderQty: p.reorderQty ?? undefined,
        })),
      ),
    staleTime: 30_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useRecordAdjustment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, StockAdjustmentDto>({
    mutationFn: (dto) =>
      apiClient.post('/inventory/movements/adjustment', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useRecordPurchase() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, StockPurchaseDto>({
    mutationFn: (dto) =>
      apiClient.post('/inventory/movements/purchase', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

// ─── Movements / history ──────────────────────────────────────────────────────

export type MovementType = 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'RETURN';

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
    queryKey: ['inventory', 'movements', params],
    queryFn: () =>
      apiClient
        .get('/inventory/movements', { params })
        .then((r) => r.data)
        .catch(() => ({ data: [], meta: { total: 0 } })),
    staleTime: 30_000,
  });
}
