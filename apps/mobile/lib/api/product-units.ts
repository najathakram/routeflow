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

const key = (productId: string) => ["products", productId, "units"] as const;

export function useProductUnits(productId: string, enabled: boolean) {
  return useQuery<ProductUnitLevel[]>({
    queryKey: key(productId),
    queryFn: () => apiClient.get(`/products/${productId}/units`).then((r) => r.data),
    enabled: enabled && !!productId,
  });
}
