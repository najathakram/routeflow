// Mobile settings parity (#2787): the same endpoints as web Settings PR-1.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PreferencePatch,
  RestrictionsSettingsDto,
  UpdateRestrictionsSettingsRequest,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import type { buildRoutePatch } from "../settings-parity-logic";

export function useUpdateRouteSettings() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, ReturnType<typeof buildRoutePatch>>({
    mutationFn: (body) => apiClient.patch("/settings/route", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["route-settings"] }),
  });
}

export function usePreferences() {
  return useQuery<Record<string, string>>({
    queryKey: ["user-preferences"],
    queryFn: () => apiClient.get("/users/me/preferences").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation<Record<string, string>, Error, PreferencePatch>({
    mutationFn: (prefs) => apiClient.patch("/users/me/preferences", prefs).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-preferences"] }),
  });
}

export function useRestrictionsSettings() {
  return useQuery<RestrictionsSettingsDto>({
    queryKey: ["restrictions-settings"],
    queryFn: () => apiClient.get("/settings/restrictions").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useUpdateRestrictionsSettings() {
  const qc = useQueryClient();
  return useMutation<RestrictionsSettingsDto, Error, UpdateRestrictionsSettingsRequest>({
    mutationFn: (body) => apiClient.patch("/settings/restrictions", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["restrictions-settings"] }),
  });
}
