import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CounterSalePaymentMethod,
  CounterSaleRequest,
  CounterSaleResponse,
  CounterSaleVoidRequest,
  CounterSaleVoidResponse,
  FulfilmentCapability,
  PickupCompleteRequest,
  PickupCompleteResponse,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { counterSaleGate, isPickupHandledError } from "../counter-sale";
import { useTenantFeatures } from "../tenant-features";

/**
 * The counter-sale gate: ONE read of `capabilities.fulfilment` from GET /tenants/me/features (never the raw `modes`).
 * Nothing shows until the answer is in, so a slow or failed request leaves the old screens exactly as they were.
 */
export function useCounterSaleGate(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { data, isLoading } = useTenantFeatures({ enabled });
  // The response type says `capabilities` is always there; a stale or partial answer may not have it, and that means DARK.
  const cap = (data as { capabilities?: { fulfilment?: FulfilmentCapability } } | undefined)
    ?.capabilities?.fulfilment;
  // `loading`: the answer is not in yet. The screen shows an empty placeholder (never "not turned on", which would be false).
  // A disabled gate (non-staff) stays DARK even when a cached answer is in the query cache.
  const gate = enabled
    ? counterSaleGate(cap)
    : { showButton: false, opensAsCounter: false, offerShipInstead: false };
  return { ...gate, capability: enabled ? cap : null, loading: enabled && isLoading === true };
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
    // The dialog answers its own pickup codes with fixed copy: no second, global toast for those (anything else keeps it).
    meta: { localErrorToast: isPickupHandledError },
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

/**
 * `POST /orders/counter-sale/:orderId/void` (SA-762r): void a sale rung today. 200 either way (`replayed: true` on a repeat,
 * the same `handBack`); every refusal is a coded 409/503 the void dialog shows as fixed copy (`counterVoidErrorCopy`), so the
 * global toast stays out of it. Today's list and the order / invoice caches refresh on success.
 */
export function useVoidCounterSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string } & CounterSaleVoidRequest) =>
      apiClient
        .post<CounterSaleVoidResponse>(`/orders/counter-sale/${encodeURIComponent(orderId)}/void`, {
          reason,
        })
        .then((r) => r.data),
    meta: { localErrorToast: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
