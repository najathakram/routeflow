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

type ApiError = { response?: { status?: number; data?: { code?: string } } };

const TWO_STEP_CODE = "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER";

/** The two-step instruction for "enable + change the address policy in one request" (by its stable code). */
export function twoStepNotice(err: unknown): string | null {
  return (err as ApiError)?.response?.data?.code === TWO_STEP_CODE
    ? "Do this in two steps: first change which address decides the state, then turn enforcement on."
    : null;
}

/** Friendly copy for the API's known refusals (never a raw 400). Keyed on the stable error code. */
export function friendlySettingsError(err: unknown): string | null {
  return twoStepNotice(err);
}
