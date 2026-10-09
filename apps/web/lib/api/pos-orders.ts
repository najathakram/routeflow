"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { usePreferences } from "@/lib/api/users";
import type { Order } from "@/lib/api/orders";

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

/**
 * The per-user preference key. TODO(P-1a): move into `@routeflow/types` PREF / PREFERENCE_KEYS when the API
 * allow-list lands it (users.controller.preferences.spec pins the three lists set-equal, so adding it to
 * the shared list alone would turn that spec red). Until then the API answers 400 for the unknown key.
 */
export const POS_MODE_PREF_KEY = "orders.posMode";

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
    mutationFn: (next) =>
      apiClient.patch("/users/me/preferences", { [POS_MODE_PREF_KEY]: next ? "true" : "false" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-preferences"] }),
  });
  const seeded = prefs.data?.[POS_MODE_PREF_KEY] === "true";
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
  constructor(
    public step: PosFinishStep,
    public cause: unknown,
  ) {
    super(`POS finish failed at ${step}`);
  }
}

/**
 * "Confirm & invoice": PATCH status CONFIRMED, then POST /invoices/from-order/:id. Both are idempotent on the
 * server, so a retry of either is safe. A failure names the step so the caller can say which half is missing
 * (the order page offers "Create invoice" when only the second failed).
 */
export function usePosFinish() {
  const qc = useQueryClient();
  return useMutation<Order, PosFinishError, { orderId: string; invoice: boolean }>({
    mutationFn: async ({ orderId, invoice }) => {
      let order: Order;
      try {
        order = (await apiClient.patch(`/orders/${orderId}/status`, { status: "CONFIRMED" })).data;
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
      return order;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
