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
import { useOptionalAuth } from "../auth-context";
import { counterSaleGate, isPickupHandledError } from "../counter-sale";
import { useTenantFeatures } from "../tenant-features";
import { keptSaleHref } from "../kept-draft-invoice";
import { deniedGroupsOf, useMyPermissions } from "./my-permissions";
import { staffMay } from "@routeflow/types";

/**
 * The counter-sale gate: ONE read of `capabilities.fulfilment` from GET /tenants/me/features (never the raw `modes`).
 * Nothing shows until the answer is in, so a slow or failed request leaves the old screens exactly as they were.
 */
export function useCounterSaleGate(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { data, isLoading, isError, fetchStatus, isFetching, refetch } = useTenantFeatures({
    enabled,
  });
  // The response type says `capabilities` is always there; a stale or partial answer may not have it, and that means DARK.
  const cap = (data as { capabilities?: { fulfilment?: FulfilmentCapability } } | undefined)
    ?.capabilities?.fulfilment;
  // `loading`: the answer is not in yet. The screen shows an empty placeholder (never "not turned on", which would be false).
  // A disabled gate (non-staff) stays DARK even when a cached answer is in the query cache.
  // BO-07: only an OPERATOR's admin can switch the till off, so only an operator's permissions are read. Admins (and
  // impersonation tokens, which carry TENANT_ADMIN) never fetch. A failed read leaves the till offered: the server refuses.
  const authUser = useOptionalAuth()?.user;
  const role = authUser?.role;
  const checkPermissions = enabled && role === "OPERATOR";
  const perms = useMyPermissions(authUser?.id, { enabled: checkPermissions });
  const permsPending = checkPermissions && perms.isLoading === true;
  const deniedGroups = checkPermissions && perms.data ? deniedGroupsOf(perms.data) : [];
  // Fail-closed flag for the builder's POS path: false while the read is pending AND after it errors (deniedGroups is
  // [] in both, which would read as "nothing denied"). Everyone but an OPERATOR has nothing to read: true.
  const permsKnown = !checkPermissions || perms.data !== undefined;
  const mayUseTill =
    checkPermissions && perms.data ? staffMay(role, "USE_POS_MODE", deniedGroups) : true;
  const baseGate = enabled
    ? counterSaleGate(cap)
    : {
        showButton: false,
        opensAsCounter: false,
        offerShipInstead: false,
        offerInvoiceOrder: false,
      };
  const open = mayUseTill && !permsPending;
  const gate = {
    ...baseGate,
    showButton: baseGate.showButton && open,
    opensAsCounter: baseGate.opensAsCounter && open,
  };
  return {
    ...gate,
    /** BO-07: the operator's admin has not turned selling on for this account (false only then). */
    mayUseTill,
    /** BO-07: the groups the operator's admin switched off (empty for everyone else); feeds `staffMay(role, action, denied)`. */
    deniedGroups,
    /** BO-07: the operator's denied groups are actually known (true for non-operators; false while pending or on error). */
    permsKnown,
    capability: enabled ? cap : null,
    loading: enabled && (isLoading === true || permsPending),
    // CQ-30: the lookup itself FAILED (a server error) or could not even start (React Query PAUSES a query while the browser is
    // offline: not loading, not an error) and there is no earlier answer. That is not "counter sales are off": the screen says
    // it could not check and offers a retry. The gate stays dark (no sale UI) either way.
    failed: enabled && data === undefined && (isError === true || fetchStatus === "paused"),
    /** a retry is in flight (the screen shows "Retrying..." and disables the button meanwhile) */
    retrying: enabled && isFetching === true,
    retry: () => refetch?.(),
  };
}

export function useCreateCounterSale() {
  const qc = useQueryClient();
  return useMutation({
    // CQ-29: React Query's default ("online") PAUSES a mutation while the browser is offline, so `mutateAsync` never settles
    // and the till sits "sending" until the connection comes back (and then sends by itself). The till must try the request
    // and see the network failure, so it can say so and unfreeze; the sale's Idempotency-Key makes any retry safe.
    networkMode: "always",
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
    // Row 466: a failure after the sale committed still wrote an order (and maybe an invoice).
    onError: (err) => {
      if (keptSaleHref(err)) {
        void qc.invalidateQueries({ queryKey: ["orders"] });
        void qc.invalidateQueries({ queryKey: ["invoices"] });
      }
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
    networkMode: "always", // CQ-29: "Check sale status" must answer (or fail) while offline, never pause silently
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
