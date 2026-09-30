// Mobile settings parity (#2787): the same endpoints as web Settings PR-1.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PreferencePatch,
  RestrictionsSettingsDto,
  UpdateRestrictionsSettingsRequest,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import type { buildRoutePatch } from "../settings-parity-logic";

/**
 * Admin settings writes never enter the offline queue (REG-B308 class): offline, the UI reports a
 * failed save, so a queued replay would silently change a setting (e.g. turn selling restrictions
 * OFF) later. `_skipOfflineQueue` is the api-client's per-request opt-out.
 */
const NO_OFFLINE_QUEUE = { _skipOfflineQueue: true } as object;

export const patchRouteSettings = (body: ReturnType<typeof buildRoutePatch>) =>
  apiClient.patch("/settings/route", body, NO_OFFLINE_QUEUE).then((r) => r.data);

export const patchUserPreferences = (prefs: PreferencePatch) =>
  apiClient.patch("/users/me/preferences", prefs, NO_OFFLINE_QUEUE).then((r) => r.data);

export const patchRestrictionsSettings = (body: UpdateRestrictionsSettingsRequest) =>
  apiClient.patch("/settings/restrictions", body, NO_OFFLINE_QUEUE).then((r) => r.data);

export function useUpdateRouteSettings() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, ReturnType<typeof buildRoutePatch>>({
    mutationFn: patchRouteSettings,
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
    mutationFn: patchUserPreferences,
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
    mutationFn: patchRestrictionsSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["restrictions-settings"] }),
  });
}
