import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CounterSaleRequest, CounterSaleResponse } from "@routeflow/types";
import { apiClient } from "../api-client";
import { counterSaleGate, type FulfilmentCapabilityLike } from "../counter-sale";
import { useTenantFeatures } from "../tenant-features";

/**
 * The counter-sale gate: ONE read of `capabilities.fulfilment` from GET /tenants/me/features (never the raw `modes`).
 * Nothing shows until the answer is in, so a slow or failed request leaves the old screens exactly as they were.
 */
export function useCounterSaleGate() {
  const { data } = useTenantFeatures();
  const cap = (
    data as unknown as { capabilities?: { fulfilment?: FulfilmentCapabilityLike } } | undefined
  )?.capabilities?.fulfilment;
  return { ...counterSaleGate(cap), capability: cap };
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
