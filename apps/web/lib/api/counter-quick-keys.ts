import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COUNTER_DEFAULT_REGISTER } from "@routeflow/pricing";
import type { QuickKeysResponse, QuickKeysSettings } from "@routeflow/types";
import { apiClient } from "../api-client";

/** Query key of the grid answer; the register is part of it so a later per-register grid caches apart. */
export const QUICK_KEYS_QUERY_KEY = "counter-quick-keys";

/**
 * SA-747: the counter sale's QUICK KEYS grid for one register. The answer carries each key's scan-lookup product
 * (no per-key fetch), so a tap needs no further request. The ranking is cached server-side for an hour; a minute here.
 */
export function useQuickKeys(register: string = COUNTER_DEFAULT_REGISTER) {
  return useQuery<QuickKeysResponse>({
    queryKey: [QUICK_KEYS_QUERY_KEY, register],
    queryFn: () =>
      apiClient
        .get("/orders/counter-sale/quick-keys", { params: { register } })
        .then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });
}

/** The saved pins/hides, read from the same `GET /settings` the screen already uses (one shared cache entry). */
export function useQuickKeysSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
    select: (s: { quickKeys?: QuickKeysSettings } | undefined) => s?.quickKeys,
  });
}

/**
 * The PATCH /settings body for one save. v1 writes `registers.main` (the server stores it as `default`); the same lists
 * are sent as `default` too, because the shared contract requires it. Other registers and the window / cap the tenant
 * set are carried over untouched.
 */
export function buildQuickKeysPatch(
  current: QuickKeysSettings | undefined,
  pinned: string[],
  hidden: string[],
): { quickKeys: QuickKeysSettings } {
  const list = { pinned: [...pinned], hidden: [...hidden] };
  const c = current?.counter;
  return {
    quickKeys: {
      counter: {
        ...(c?.windowDays !== undefined ? { windowDays: c.windowDays } : {}),
        ...(c?.cap !== undefined ? { cap: c.cap } : {}),
        default: list,
        registers: { ...(c?.registers ?? {}), [COUNTER_DEFAULT_REGISTER]: list },
      },
    },
  };
}

export function useSaveQuickKeys() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { quickKeys: QuickKeysSettings }) =>
      apiClient.patch("/settings", body).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [QUICK_KEYS_QUERY_KEY] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
