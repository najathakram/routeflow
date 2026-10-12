import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  BucketKey,
  BulkStateResult,
  StateWriteResult,
  UnknownStateBucket,
  UnknownStateBuckets,
} from "../unknown-state";
import { PAGE } from "../unknown-state";

const BASE = "/settings/restrictions/unknown-state-customers";
export const UNKNOWN_STATE_KEY = ["restrictions-settings", "unknown-state-customers"] as const;

/** The three buckets, first page of each (the card loads its own data; there is no "Check readiness" gate). */
export function useUnknownStateBuckets(limit = PAGE) {
  return useQuery<UnknownStateBuckets>({
    queryKey: [...UNKNOWN_STATE_KEY, limit],
    queryFn: () => apiClient.get(BASE, { params: { limit } }).then((r) => r.data),
    retry: false,
  });
}

/** "Show more": one bucket, the page after `cursor`. */
export async function fetchBucketPage(
  bucket: BucketKey,
  cursor: string,
  limit = PAGE,
): Promise<UnknownStateBucket> {
  const { data } = await apiClient.get(BASE, { params: { bucket, cursor, limit } });
  return (data as UnknownStateBuckets)[bucket];
}

const refresh = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: UNKNOWN_STATE_KEY });

/** The mutations render their own inline error under the field, so they opt out of the global toast. */
const LOCAL = { localErrorToast: true } as const;

/** Set (or confirm, `confirmReview`) the state of an existing address. */
export function useSetAddressState() {
  return useMutation<
    StateWriteResult,
    Error,
    { customerId: string; addressId: string; state: string; confirmReview?: boolean }
  >({
    meta: LOCAL,
    mutationFn: ({ customerId, addressId, ...body }) =>
      apiClient
        .patch(`/customers/${customerId}/addresses/${addressId}/state`, body)
        .then((r) => r.data),
  });
}

/** A customer with no address: create the minimal default billing address with this state. */
export function useCreateMinimalAddress() {
  return useMutation<StateWriteResult, Error, { customerId: string; state: string; zip?: string }>({
    meta: LOCAL,
    mutationFn: ({ customerId, ...body }) =>
      apiClient.post(`/customers/${customerId}/addresses/minimal`, body).then((r) => r.data),
  });
}

export function useBulkSetState() {
  return useMutation<
    BulkStateResult,
    Error,
    { bucket: BucketKey; customerIds: string[]; state: string }
  >({
    meta: LOCAL,
    mutationFn: (body) => apiClient.post(`${BASE}/bulk-state`, body).then((r) => r.data),
  });
}

export function useUndoBulkState() {
  const qc = useQueryClient();
  return useMutation<{ restored: number }, Error, { changedAddressIds: string[] }>({
    mutationFn: (body) => apiClient.post(`${BASE}/bulk-state/undo`, body).then((r) => r.data),
    onSuccess: () => refresh(qc),
  });
}

export function useRefreshUnknownState() {
  const qc = useQueryClient();
  return () => refresh(qc);
}
