import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProductUnitPayload,
  ProductUnitLevel,
  UpdateProductUnitPayload,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { useSubscription } from "./billing";
import { priceGridKey } from "./usePriceGrid";

/** The plan flag that gates the whole multi-level-units surface (server registry row). */
export const UNITS_FLAG = "flag.units_v1";

/**
 * Does the tenant's subscription serve `flag.units_v1`? Deliberately FAIL-CLOSED (unlike
 * `usePlanFlag`, which fails open for route guards): an unknown answer must never reveal an
 * editor whose every call would 403, so the surface stays hidden until the flag is confirmed.
 */
export function useUnitsEnabled(opts?: { enabled?: boolean }): boolean {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return (q.data?.flags ?? []).includes(UNITS_FLAG);
}

/** U-1's Units screen sits behind its own flag (SA ruling), separate from the line-level units_v1. */
export const UNITS_SETTINGS_FLAG = "flag.units_settings_v1";

/** Does the subscription serve `flag.units_settings_v1`? Fail-CLOSED, like useUnitsEnabled: unknown = hidden. */
export function useUnitsSettingsEnabled(opts?: { enabled?: boolean }): boolean {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return (q.data?.flags ?? []).includes(UNITS_SETTINGS_FLAG);
}

const key = (productId: string) => ["products", productId, "units"] as const;
export const productUnitsKey = key;

/** The product's ladder (shared by the picker's query and the order's default-unit resolver, SA-626c). */
export const fetchProductUnits = (productId: string): Promise<ProductUnitLevel[]> =>
  apiClient.get(`/products/${productId}/units`).then((r) => r.data);

export function useProductUnits(productId: string, enabled: boolean) {
  return useQuery<ProductUnitLevel[]>({
    queryKey: key(productId),
    queryFn: () => fetchProductUnits(productId),
    enabled: enabled && !!productId,
  });
}

/** B1245: the v2 prices grid has a row per unit, so every unit write refreshes it as well as the ladder list. */
function useInvalidate(productId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key(productId) }),
      qc.invalidateQueries({ queryKey: priceGridKey(productId) }),
    ]);
}

export function useCreateProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: (body: CreateProductUnitPayload) =>
      apiClient.post(`/products/${productId}/units`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProductUnitPayload & { id: string }) =>
      apiClient.patch(`/products/${productId}/units/${id}`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete(`/products/${productId}/units/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
}
