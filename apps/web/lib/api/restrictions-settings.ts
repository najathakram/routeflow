import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { RestrictionsSettingsDto, UpdateRestrictionsSettingsRequest } from "@routeflow/types";
export type { RestrictionsSettingsDto, UpdateRestrictionsSettingsRequest };

const KEY = ["restrictions-settings"] as const;

export function useRestrictionsSettings() {
  return useQuery<RestrictionsSettingsDto>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/restrictions").then((r) => r.data),
  });
}

export function useUpdateRestrictionsSettings() {
  const qc = useQueryClient();
  return useMutation<RestrictionsSettingsDto, Error, UpdateRestrictionsSettingsRequest>({
    mutationFn: (dto) => apiClient.patch("/settings/restrictions", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
