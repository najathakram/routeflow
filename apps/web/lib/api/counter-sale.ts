import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CounterSalePaymentMethod,
  CounterSaleRequest,
  CounterSaleResponse,
  FulfilmentCapability,
  PickupCompleteRequest,
  PickupCompleteResponse,
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      idempotencyKey,
      method,
    }: {
      idempotencyKey: string;
      /** the method THIS attempt rang: the server applies POST's paymentRecorded rule for it */
      method: CounterSalePaymentMethod;
    }) =>
      apiClient
        .get<CounterSaleResponse>(
          `/orders/counter-sale/by-key/${encodeURIComponent(idempotencyKey)}`,
          { params: { method } },
        )
        .then((r) => r.data),
    // a recovered sale is a sale: today's list (under ["orders"]) refreshes like a normal one
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

/**
 * `POST /orders/:id/pickup-complete`: staff hand a PICKUP order over ("Picked up"). The `Idempotency-Key` is REQUIRED and is
 * the DIALOG's (one per open, kept across retries), so it is passed in, never minted here. A 200 with `paymentRecorded: false`
 * is still a hand-over that happened, so the order and its invoices refresh on every 2xx.
 */
export function usePickupComplete(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      idempotencyKey,
    }: {
      body: PickupCompleteRequest;
      idempotencyKey: string;
    }) =>
      apiClient
        .post<PickupCompleteResponse>(`/orders/${orderId}/pickup-complete`, body, {
          headers: { "Idempotency-Key": idempotencyKey },
        })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

/** The order's live invoices read in full, for their server-computed `balanceDue` (the order payload carries no paid figure). */
export function usePickupInvoiceBalances(invoiceIds: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: ["invoices", "pickup-balance", ...invoiceIds],
    enabled: enabled && invoiceIds.length > 0,
    staleTime: 0,
    queryFn: () =>
      Promise.all(
        invoiceIds.map((id) =>
          apiClient
            .get<{ status: string; total: number; balanceDue?: number }>(`/invoices/${id}`)
            .then((r) => r.data),
        ),
      ),
  });
}
