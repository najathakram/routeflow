import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API_ERROR_CODES,
  type FulfilmentPreview,
  type FulfilmentSettings,
  type FulfilmentSettingsPatchRequest,
  type FulfilmentSettingsUpdated,
  type UpdateFulfilmentSettingsRequest,
} from "@routeflow/types";
import { apiClient } from "../api-client";
export type {
  FulfilmentPreview,
  FulfilmentSettings,
  FulfilmentSettingsPatchRequest,
  FulfilmentSettingsUpdated,
  UpdateFulfilmentSettingsRequest,
};

/**
 * Settings → Fulfillment: the typed face over `fulfilment_model` and `counter_sales`. `GET` is OPERATOR;
 * preview and change are TENANT_ADMIN and dark behind the API's FULFILMENT_SELF_SERVE (`selfServe` on the
 * GET body says whether the tab exists). A change carries the `fingerprint` of the preview the admin read;
 * the server answers a stale one with a 409 whose body is a fresh GET body.
 */
export const FULFILMENT_SETTINGS_KEY = ["fulfilment-settings"] as const;

export function useFulfilmentSettings(options: { enabled?: boolean } = {}) {
  return useQuery<FulfilmentSettings>({
    queryKey: FULFILMENT_SETTINGS_KEY,
    queryFn: () => apiClient.get("/settings/fulfilment").then((r) => r.data),
    enabled: options.enabled ?? true,
  });
}

export function useFulfilmentPreview() {
  return useMutation<FulfilmentPreview, Error, UpdateFulfilmentSettingsRequest>({
    mutationFn: (dto) => apiClient.post("/settings/fulfilment/preview", dto).then((r) => r.data),
  });
}

export function useUpdateFulfilmentSettings() {
  const qc = useQueryClient();
  return useMutation<FulfilmentSettingsUpdated, Error, FulfilmentSettingsPatchRequest>({
    mutationFn: (dto) => apiClient.patch("/settings/fulfilment", dto).then((r) => r.data),
    onSuccess: ({ changed: _changed, ...settings }) => {
      qc.setQueryData<FulfilmentSettings>(FULFILMENT_SETTINGS_KEY, settings);
      // The counter gate and the capability answers live under the tenant caches.
      void qc.invalidateQueries({ queryKey: ["tenant"] });
    },
  });
}

/** What a refused call carried: the HTTP status, the machine code and the body. */
export interface FulfilmentRefusal {
  status?: number;
  code?: string;
  data?: Record<string, unknown>;
}

export function fulfilmentRefusalOf(error: unknown): FulfilmentRefusal {
  const res = (error as { response?: { status?: number; data?: Record<string, unknown> } })
    ?.response;
  const code = res?.data?.code;
  return {
    status: res?.status,
    code: typeof code === "string" ? code : undefined,
    data: res?.data,
  };
}

/** The 409 STALE body is a fresh GET body inside the coded envelope; this picks the GET fields (the envelope's text is never read). */
export function settingsFromStaleBody(data: Record<string, unknown>): FulfilmentSettings | null {
  if (!data.fingerprint || !data.fulfilmentModel) return null;
  return {
    fulfilmentModel: data.fulfilmentModel,
    counterSales: data.counterSales,
    capability: data.capability,
    selfServe: data.selfServe,
    canEdit: data.canEdit,
    fingerprint: data.fingerprint,
    lastChange: data.lastChange ?? null,
  } as FulfilmentSettings;
}

export const FULFILMENT_REFUSAL = {
  stale: API_ERROR_CODES.FULFILMENT_SETTINGS_STALE,
  carrier: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT,
  needsFleet: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
} as const;
