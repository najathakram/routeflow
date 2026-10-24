import { useQuery } from "@tanstack/react-query";
import type { ProductUnitLevel } from "@routeflow/types";
import { apiClient } from "../api-client";
import { useSubscription } from "./billing";

/**
 * Mobile mirror of `apps/web/lib/api/product-units.ts` (units_v1) — same wire contract
 * (`GET /products/:id/units`, `flag.units_v1`), same FAIL-CLOSED read: an unknown/loading/errored
 * subscription answer must never reveal a unit-picker whose every write would 403, so the flag
 * defaults to false, not true, while unresolved.
 */
export const UNITS_FLAG = "flag.units_v1";

export function useUnitsEnabled(): boolean {
  const q = useSubscription();
  return (q.data?.flags ?? []).includes(UNITS_FLAG);
}

export const productUnitsKey = (productId: string) => ["products", productId, "units"] as const;

/** The product's ladder (shared by the picker's query and the cart's default-unit resolver, SA-626c). */
export const fetchProductUnits = (productId: string): Promise<ProductUnitLevel[]> =>
  apiClient.get(`/products/${productId}/units`).then((r) => r.data);

export function useProductUnits(productId: string, enabled: boolean) {
  return useQuery<ProductUnitLevel[]>({
    queryKey: productUnitsKey(productId),
    queryFn: () => fetchProductUnits(productId),
    enabled: enabled && !!productId,
  });
}
