import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PickupCompleteRequest,
  PickupCompleteResponse,
  RestrictionAck,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { getOrderSubmitKey, resetOrderSubmitKey } from "../order-submit-key";
import { invalidateOrderCaches } from "./orders";
import { splitIdAck, type IdWithAck } from "../restriction-warning";
import {
  POS_MODE_PREF_KEY,
  pendingRefusalIsDone,
  posConfirmSteps,
  posConfirmStepsAfterPending,
  posModeFromPreferences,
  posModePrefPatch,
  posStatusBody,
  type PosFinishStep,
} from "../pos-mode";

const PREFS_KEY = ["user-preferences"] as const;

/** POS mode (SA-763r P-2), the server-backed switch: GET to seed, PATCH on flip, never AsyncStorage. */
export function usePosModePreference() {
  const qc = useQueryClient();
  const prefs = useQuery<Record<string, string>>({
    queryKey: PREFS_KEY,
    queryFn: () => apiClient.get("/users/me/preferences").then((r) => r.data),
    staleTime: 60_000,
  });
  const save = useMutation<unknown, Error, boolean>({
    mutationFn: (next) => apiClient.patch("/users/me/preferences", posModePrefPatch(next)),
    onSuccess: () => qc.invalidateQueries({ queryKey: PREFS_KEY }),
  });
  return { prefs, save, seeded: posModeFromPreferences(prefs.data), key: POS_MODE_PREF_KEY };
}

export class PosFinishError extends Error {
  constructor(
    public step: PosFinishStep,
    public cause: unknown,
  ) {
    super(`POS finish failed at ${step}`);
  }
}

async function rereadAfterRefusedPending(orderId: string, e: unknown): Promise<string | null> {
  const httpStatus = (e as { response?: { status?: number } } | null)?.response?.status;
  if (httpStatus !== 400 && httpStatus !== 409) return null;
  try {
    const cur = (await apiClient.get(`/orders/${orderId}`)).data as { status?: string } | undefined;
    return pendingRefusalIsDone(httpStatus, cur?.status) ? (cur?.status ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * "Confirm & invoice": PATCH status CONFIRMED, then POST /invoices/from-order/:id. Both are idempotent
 * on the server; a failure names the step so the caller says which half is missing.
 */
export function usePosFinish() {
  const qc = useQueryClient();
  return useMutation<
    void,
    PosFinishError,
    // Row 510: a confirm into a judged DRAFT can answer 409 RESTRICTION_WARNING; the resubmit carries the ack.
    { orderId: string; invoice: boolean; fromStatus?: string | null } & RestrictionAck
  >({
    mutationFn: async ({ orderId, invoice, fromStatus, ...ack }) => {
      try {
        let reread: string | null = null;
        for (const status of posConfirmSteps(fromStatus)) {
          if (status === "CONFIRMED" && posConfirmStepsAfterPending(reread).length === 0) continue;
          try {
            await apiClient.patch(`/orders/${orderId}/status`, posStatusBody(status, ack));
          } catch (e) {
            // PENDING is the only step that can be a re-run; a refusal is "done" only if a re-read agrees.
            if (status !== "PENDING") throw e;
            reread = await rereadAfterRefusedPending(orderId, e);
            if (reread === null) throw e;
          }
        }
      } catch (e) {
        throw new PosFinishError("confirm", e);
      }
      if (invoice) {
        try {
          await apiClient.post(`/invoices/from-order/${orderId}`);
        } catch (e) {
          throw new PosFinishError("invoice", e);
        }
      }
    },
    onSettled: () => {
      invalidateOrderCaches(qc);
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

/** Release the hand-over's Idempotency-Key (see `decidePickupResponse`). */
export function releasePickupKey(orderId: string): void {
  resetOrderSubmitKey(`pickup:${orderId}`);
}

/**
 * "Hand over": `POST /orders/:id/pickup-complete` (DELIVERED + the invoice issued). The Idempotency-Key
 * is REQUIRED; it is one per order and kept across retries, released by the caller once the payment is recorded.
 */
export function usePickupComplete(orderId: string) {
  const qc = useQueryClient();
  return useMutation<PickupCompleteResponse, Error, PickupCompleteRequest | undefined>({
    mutationFn: (body) =>
      apiClient
        .post<PickupCompleteResponse>(`/orders/${orderId}/pickup-complete`, body ?? {}, {
          headers: { "Idempotency-Key": getOrderSubmitKey(`pickup:${orderId}`) },
        })
        .then((r) => r.data),
    // The Idempotency-Key is released by the caller (`releasePickupKey`) only once the payment is
    // recorded: a 200 with `paymentRecorded: false` must be retried with the SAME key.
    onSuccess: () => {
      invalidateOrderCaches(qc);
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
    },
  });
}

/**
 * Move an order off pickup (open states only; the server decides): "Switch to delivery" sends ROUTE, "Ship by
 * carrier…" SHIP, both through `PATCH /orders/:id/fulfill-path`, the endpoint web's `usePatchOrderFulfillPath` uses.
 */
export function useMoveOrderOffPickup() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { id: string; fulfillPath: "ROUTE" | "SHIP" } & Partial<RestrictionAck>
  >({
    // row 510: the path switch is re-judged, so it can carry an ack (restrictionOverrides + warningHash)
    mutationFn: ({ id, fulfillPath, ...ack }) =>
      apiClient.patch(`/orders/${id}/fulfill-path`, { fulfillPath, ...ack }),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

/**
 * The order's live invoices read in full, for their server-computed `balanceDue` (GET /orders/:id
 * invoices carry no paid figure, so a deposit would otherwise read as the gross total).
 */
export function usePickupInvoiceBalances(invoiceIds: readonly string[], enabled: boolean) {
  return useQuery<{ status: string; total: number; balanceDue?: number }[]>({
    queryKey: ["invoices", "pickup-balance", ...invoiceIds],
    enabled: enabled && invoiceIds.length > 0,
    staleTime: 0,
    gcTime: 0, // never show a previous open's balance
    queryFn: () =>
      Promise.all(invoiceIds.map((id) => apiClient.get(`/invoices/${id}`).then((r) => r.data))),
  });
}
