import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { LadderPutBody } from "../unit-ladder";
import { productUnitsKey } from "./product-units";

/** A tenant unit name for the editor's pickers. `archived` ones are only shown when a product already uses them. */
export interface TenantUnitName {
  id?: string;
  name: string;
  archived: boolean;
}

/** GET /products/:id/units/tenant-units (the flagged controller; U-1's /units supersedes it). */
export function useTenantUnitNames(productId: string, enabled: boolean) {
  return useQuery<TenantUnitName[]>({
    queryKey: ["products", productId, "units", "tenant-units"],
    queryFn: () => apiClient.get(`/products/${productId}/units/tenant-units`).then((r) => r.data),
    enabled: enabled && !!productId,
    staleTime: 60_000,
  });
}

/** PUT /products/:id/units: the structural save. The editor renders every error inline, so no global toast. */
export function useReplaceProductUnits(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LadderPutBody) =>
      apiClient.put(`/products/${productId}/units`, body).then((r) => r.data),
    meta: { localErrorToast: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: productUnitsKey(productId) });
      qc.invalidateQueries({ queryKey: ["products", productId] });
    },
  });
}

/** The create modal's follow-up PUT: it has no cached query for a product that did not exist a moment ago. */
export const putProductUnits = (productId: string, body: LadderPutBody) =>
  apiClient.put(`/products/${productId}/units`, body).then((r) => r.data);
