"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { usePreferences } from "@/lib/api/users";
import type { Order } from "@/lib/api/orders";
import { PREF } from "@routeflow/types";

/**
 * POS mode (SA-763r P-2): a staff order created with `fulfillPath: PICKUP` from Create Order.
 * The order's own `fulfillPath` is the snapshot; there is no `Order.posMode` column, and counter sales
 * (PICKUP + `counterSale: true`) are NOT POS-mode orders, so every predicate is the pair below.
 */
export function isPosOrder(
  order: { fulfillPath?: string | null; counterSale?: boolean | null } | null | undefined,
): boolean {
  return order?.fulfillPath === "PICKUP" && order?.counterSale !== true;
}

export interface PosModeState {
  /** The switch position. Seeded from GET /users/me/preferences, then follows the operator's flips. */
  posMode: boolean;
  /** False until the preference GET has answered: the switch is disabled so a flip can't race the seed. */
  known: boolean;
  setPosMode: (next: boolean) => void;
  /** True while a PATCH is in flight. */
  saving: boolean;
  /** Set when the last PATCH failed (the switch has already rolled back). */
  failed: boolean;
}

/** Server-backed switch: written with PATCH on flip, never localStorage. Unset = off. */
export function usePosMode(): PosModeState {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const [override, setOverride] = React.useState<boolean | null>(null);
  const [failed, setFailed] = React.useState(false);
  const save = useMutation<unknown, Error, boolean>({
    meta: { localErrorToast: true }, // the switch renders its own inline failure
    mutationFn: (next) =>
      apiClient.patch("/users/me/preferences", { [PREF.ordersPosMode]: next ? "true" : "false" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-preferences"] }),
  });
  const seeded = prefs.data?.[PREF.ordersPosMode] === "true";
  return {
    posMode: override ?? seeded,
    known: prefs.isSuccess || prefs.isError,
    saving: save.isPending,
    failed,
    setPosMode: (next) => {
      const previous = override ?? seeded;
      setOverride(next);
      setFailed(false);
      save.mutate(next, {
        onError: () => {
          setOverride(previous);
          setFailed(true);
        },
      });
    },
  };
}

export type PosFinishStep = "confirm" | "invoice";

export class PosFinishError extends Error {
  /** The underlying axios `.response`, kept so callers can map the coded refusal. */
  response?: unknown;
  constructor(
    public step: PosFinishStep,
    public cause: unknown,
  ) {
    super(`POS finish failed at ${step}`);
    this.response = (cause as { response?: unknown } | null)?.response;
  }
}

/**
 * "Confirm & invoice": (DRAFT target only: PATCH status PENDING first,) PATCH status CONFIRMED, then POST /invoices/from-order/:id.
 * The status PATCHes are NOT idempotent (the API refuses PENDING -> PENDING and CONFIRMED -> CONFIRMED), so the
 * PENDING step re-reads the order when it is refused with a 400/409 and carries on only if the order already is
 * PENDING or CONFIRMED (someone else promoted it, or a retry). A failure names the step so the caller can say which
 * half is missing (the order page offers "Create invoice" when only the second failed).
 */
async function promotedAlready(orderId: string, e: unknown): Promise<Order | null> {
  const status = (e as { response?: { status?: number } } | null)?.response?.status;
  if (status !== 400 && status !== 409) return null;
  try {
    const cur = (await apiClient.get(`/orders/${orderId}`)).data as Order | undefined;
    return cur?.status === "PENDING" || cur?.status === "CONFIRMED" ? cur : null;
  } catch {
    return null;
  }
}

/** See `promotedAlready`: the doc block above describes the whole flow. */
export function usePosFinish() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    PosFinishError,
    { orderId: string; invoice: boolean; fromStatus?: string | null }
  >({
    meta: { localErrorToast: true }, // the Create Order modal toasts which half is missing
    mutationFn: async ({ orderId, invoice, fromStatus }) => {
      let order: Order | undefined;
      try {
        // The API's table has no DRAFT -> CONFIRMED edge (DRAFT -> PENDING only), so a merge into an open
        // DRAFT promotes it first. Not idempotent: a refused PENDING (409/400) is treated as done only when
        // the order now reads PENDING/CONFIRMED (a retry, or someone else promoted it).
        if (fromStatus === "DRAFT") {
          try {
            await apiClient.patch(`/orders/${orderId}/status`, { status: "PENDING" });
          } catch (e) {
            const cur = await promotedAlready(orderId, e);
            if (!cur) throw e;
            // Already CONFIRMED (a retry): CONFIRMED -> CONFIRMED is a 400, so do not send it again.
            if (cur.status === "CONFIRMED") order = cur;
          }
        }
        order ??= (await apiClient.patch(`/orders/${orderId}/status`, { status: "CONFIRMED" }))
          .data;
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
      return order as Order;
    },
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", vars.orderId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
