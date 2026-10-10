// Counter sale PARK / RESUME (SA-748): the four calls behind the Park button and the Parked (n) list. The shapes are the
// shared contract in @routeflow/pricing. Nothing here touches stock or money: a parked cart is a saved cart.
import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  ParkCartRequest,
  ParkCartResponse,
  ParkedCartListResponse,
  ParkedCartPayload,
  ResumeParkedCartRequest,
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

// What the screen holds between taps, per QueryClient (so two screens, or two tests, never share it): the park id kept for a
// retry of the SAME park, and the resume attempt id kept for a retry of the SAME resume tap.
const heldParks = new WeakMap<QueryClient, { id: string; sig: string }>();
const heldResumes = new WeakMap<QueryClient, { id: string; attemptId: string }>();

/** A definitive refusal (the server read the request and said no): a 4xx other than "slow down / timed out". */
function isDefinitive(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

/**
 * Parks the cart. The id is minted HERE, in the browser, and kept for a retry of the SAME park (same payload), so a lost
 * response can never leave two rows; a different cart, or the next park after a success, mints a new one. It is also
 * dropped on any definitive 4xx (a refused id is never reused) and when that row is resumed (see `useResume`), because the
 * server no longer replays a closed row.
 */
export function usePark() {
  const refresh = useRefreshList();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ParkedCartPayload) => {
      const sig = JSON.stringify(payload);
      let held = heldParks.get(qc);
      if (!held || held.sig !== sig) {
        held = { id: newIdempotencyKey(), sig };
        heldParks.set(qc, held);
      }
      const body: ParkCartRequest = { id: held.id, payload };
      try {
        const res = await apiClient.post<ParkCartResponse>(BASE, body);
        heldParks.delete(qc);
        return res.data;
      } catch (err) {
        if (isDefinitive(err)) heldParks.delete(qc);
        throw err;
      }
    },
    onSettled: refresh,
  });
}

/**
 * Takes a parked cart back (a compare-and-set on the server: exactly one till wins). Each tap carries its own
 * `resumeAttemptId` (uuid v4); it is reused only when the previous tap on the SAME cart ended without an answer (a network
 * error or a 5xx, so the row may already be taken by THIS tap), and dropped on any definitive result. Another till has its
 * own id and is refused with 404 PARK_TAKEN.
 */
export function useResume() {
  const refresh = useRefreshList();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      let held = heldResumes.get(qc);
      if (!held || held.id !== id) {
        held = { id, attemptId: newIdempotencyKey() };
        heldResumes.set(qc, held);
      }
      const body: ResumeParkedCartRequest = { resumeAttemptId: held.attemptId };
      try {
        const res = await apiClient.post<ResumeParkedCartResponse>(
          `${BASE}/${encodeURIComponent(id)}/resume`,
          body,
        );
        heldResumes.delete(qc);
        // The row this park id named is now taken: a park of the same cart again is a new park, not a replay.
        if (heldParks.get(qc)?.id === id) heldParks.delete(qc);
        return res.data;
      } catch (err) {
        if (isDefinitive(err)) heldResumes.delete(qc);
        throw err;
      }
    },
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
