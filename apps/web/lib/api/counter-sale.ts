import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CounterSaleRequest,
  CounterSaleResponse,
  FulfilmentCapability,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { counterSaleGate } from "../counter-sale";
import { useTenantFeatures } from "../tenant-features";

/**
 * The counter-sale gate: ONE read of `capabilities.fulfilment` from GET /tenants/me/features (never the raw `modes`).
 * Nothing shows until the answer is in, so a slow or failed request leaves the old screens exactly as they were.
 */
export function useCounterSaleGate() {
  const { data, isLoading } = useTenantFeatures();
  // The response type says `capabilities` is always there; a stale or partial answer may not have it, and that means DARK.
  const cap = (data as { capabilities?: { fulfilment?: FulfilmentCapability } } | undefined)
    ?.capabilities?.fulfilment;
  // `loading`: the answer is not in yet. The screen shows an empty placeholder (never "not turned on", which would be false).
  return { ...counterSaleGate(cap), capability: cap, loading: isLoading === true };
}

export function useCreateCounterSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dto, idempotencyKey }: { dto: CounterSaleRequest; idempotencyKey: string }) =>
      apiClient
        .post<CounterSaleResponse>("/orders/counter-sale", dto, {
          headers: { "Idempotency-Key": idempotencyKey },
        })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

/**
 * `GET /orders/counter-sale/by-key/:key`: did a sale get written under this Idempotency-Key? 200 = the sale
 * (`replayed: true`), 404 COUNTER_SALE_NOT_FOUND = never written. A mutation (an imperative, on-demand check), not a cache.
 */
export function useCounterSaleByKey() {
  return useMutation({
    mutationFn: (idempotencyKey: string) =>
      apiClient
        .get<CounterSaleResponse>(
          `/orders/counter-sale/by-key/${encodeURIComponent(idempotencyKey)}`,
        )
        .then((r) => r.data),
  });
}
