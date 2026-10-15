import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { InventorySettings, UpdateInventorySettingsRequest } from "@routeflow/types";
export type { InventorySettings, UpdateInventorySettingsRequest };

/**
 * Settings → Out-of-stock ordering: the typed face over the `orders.buyerOversell` policy
 * (`GET` is OPERATOR, `PATCH` is TENANT_ADMIN). "off" refuses a buyer order past available stock,
 * "backorder" accepts it. Only the exact string "backorder" ever means "on" (the server reads it the
 * same way and fails closed), so a missing or unknown value is "off".
 */
const KEY = ["inventory-settings"] as const;

export function useInventorySettings() {
  return useQuery<InventorySettings>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/inventory").then((r) => r.data),
  });
}

export function useUpdateInventorySettings() {
  const qc = useQueryClient();
  return useMutation<InventorySettings, Error, UpdateInventorySettingsRequest>({
    mutationFn: (dto) => apiClient.patch("/settings/inventory", dto).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
