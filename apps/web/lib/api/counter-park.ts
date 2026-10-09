// Counter sale PARK / RESUME (SA-748): the four calls behind the Park button and the Parked (n) list. The shapes are the
// shared contract in @routeflow/pricing. Nothing here touches stock or money: a parked cart is a saved cart.
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ParkCartRequest,
  ParkCartResponse,
  ParkedCartListResponse,
  ParkedCartPayload,
  ResumeParkedCartResponse,
} from "@routeflow/pricing";
import { apiClient } from "../api-client";
import { newIdempotencyKey } from "../counter-sale";

export const COUNTER_PARK_KEY = ["counter-sale-parked"] as const;
const BASE = "/orders/counter-sale/parked";

/** The open parked carts of a register, newest first (page 1: a register holds at most 10). */
export function useParkedCarts(register?: string, enabled = true) {
  return useQuery<ParkedCartListResponse>({
    queryKey: [...COUNTER_PARK_KEY, register ?? null],
    queryFn: () =>
      apiClient
        .get<ParkedCartListResponse>(BASE, {
          params: { ...(register ? { register } : {}), page: 1 },
        })
        .then((r) => r.data),
    staleTime: 10_000,
    enabled,
  });
}

function useRefreshList() {
  const qc = useQueryClient();
  return React.useCallback(() => void qc.invalidateQueries({ queryKey: COUNTER_PARK_KEY }), [qc]);
}

/**
 * Parks the cart. The id is minted HERE, in the browser, and kept for a retry of the SAME park (same payload), so a lost
 * response can never leave two rows; a different cart, or the next park after a success, mints a new one.
 */
export function usePark() {
  const refresh = useRefreshList();
  const held = React.useRef<{ id: string; sig: string } | null>(null);
  return useMutation({
    mutationFn: async (payload: ParkedCartPayload) => {
      const sig = JSON.stringify(payload);
      if (!held.current || held.current.sig !== sig)
        held.current = { id: newIdempotencyKey(), sig };
      const body: ParkCartRequest = { id: held.current.id, payload };
      const res = await apiClient.post<ParkCartResponse>(BASE, body);
      held.current = null;
      return res.data;
    },
    onSettled: refresh,
  });
}

/** Takes a parked cart back (a compare-and-set on the server: exactly one till wins). */
export function useResume() {
  const refresh = useRefreshList();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient
        .post<ResumeParkedCartResponse>(`${BASE}/${encodeURIComponent(id)}/resume`)
        .then((r) => r.data),
    onSettled: refresh,
  });
}

export function useDiscard() {
  const refresh = useRefreshList();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete(`${BASE}/${encodeURIComponent(id)}`).then((r) => r.data),
    onSettled: refresh,
  });
}
