import { useQuery } from "@tanstack/react-query";
import type { ProductUnitLevel } from "@routeflow/types";
import { apiClient } from "../api-client";
import { useSubscription } from "./billing";

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

const key = (productId: string) => ["products", productId, "units"] as const;

export function useProductUnits(productId: string, enabled: boolean) {
  return useQuery<ProductUnitLevel[]>({
    queryKey: key(productId),
    queryFn: () => apiClient.get(`/products/${productId}/units`).then((r) => r.data),
    enabled: enabled && !!productId,
  });
}
