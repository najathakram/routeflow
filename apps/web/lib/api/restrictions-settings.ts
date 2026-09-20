import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  RestrictionsEnableReadiness,
  RestrictionsSettingsDto,
  UpdateRestrictionsSettingsRequest,
} from "@routeflow/types";
export type {
  RestrictionsEnableReadiness,
  RestrictionsSettingsDto,
  UpdateRestrictionsSettingsRequest,
};

const KEY = ["restrictions-settings"] as const;

export function useRestrictionsSettings() {
  return useQuery<RestrictionsSettingsDto>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/restrictions").then((r) => r.data),
  });
}

/** The customer sweep. Never automatic (`enabled: false`): the admin runs it with `refetch()`. */
export function useRestrictionsReadiness() {
  return useQuery<RestrictionsEnableReadiness>({
    queryKey: [...KEY, "readiness"],
    queryFn: () => apiClient.get("/settings/restrictions/readiness").then((r) => r.data),
    enabled: false,
    retry: false,
  });
}

export function useUpdateRestrictionsSettings() {
  const qc = useQueryClient();
  return useMutation<RestrictionsSettingsDto, Error, UpdateRestrictionsSettingsRequest>({
    mutationFn: (dto) => apiClient.patch("/settings/restrictions", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

type ApiError = {
  response?: { status?: number; data?: { code?: string; readiness?: RestrictionsEnableReadiness } };
};

/** The 409 the API returns when the tenant's data isn't ready to enable, with what to fix. */
export function notReadyReadiness(err: unknown): RestrictionsEnableReadiness | null {
  const r = (err as ApiError)?.response;
  return r?.status === 409 && r.data?.code === "SELLING_RESTRICTIONS_NOT_READY"
    ? (r.data.readiness ?? null)
    : null;
}

/**
 * Friendly copy for the API's known refusals (never a raw 400/429). Keyed on the stable error code /
 * status, not on message text.
 */
export function friendlySettingsError(err: unknown): string | null {
  const r = (err as ApiError)?.response;
  if (r?.data?.code === "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER") {
    return "Do this in two steps: first change which address decides the state, then turn enforcement on.";
  }
  if (r?.status === 429) return "Too many readiness checks. Wait a minute and try again.";
  return null;
}
