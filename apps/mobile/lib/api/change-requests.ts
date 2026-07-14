import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export type ChangeRequestType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";
export type ChangeRequestStatus = "PENDING" | "APPROVED" | "DECLINED";
export type ChangeRequestResolution = "MERGED_AT_STOP" | "NEXT_DELIVERY" | "DECLINED";

/**
 * Post-dispatch change requests (P5-09 engine). Mirrors apps/web/lib/change-requests.ts'
 * server-contract types. Mobile adds the mutations web never needed: the driver-at-stop
 * flow CREATES a request and immediately self-resolves it (G6: "driver-at-stop is the
 * primary authority" — apps/api/src/orders/change-requests.service.ts:33-34).
 */
export interface ChangeRequest {
  id: string;
  orderId: string;
  orderItemId: string | null;
  productId: string | null;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  payload: {
    productId?: string;
    qty?: number;
    boxes?: number | null;
    pieces?: number | null;
    productName?: string;
    orderItemId?: string;
    newQty?: number;
    text?: string;
  };
  note: string | null;
  resolution: ChangeRequestResolution | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** Mirrors apps/api/src/orders/dto/create-change-request.dto.ts exactly. */
export interface CreateChangeRequestInput {
  type: ChangeRequestType;
  orderItemId?: string;
  productId?: string;
  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  qty?: number;
  boxes?: number;
  pieces?: number;
  note?: string;
}

export function useCreateChangeRequest(orderId: string) {
  return useMutation<ChangeRequest, Error, CreateChangeRequestInput>({
    mutationFn: (dto) =>
      apiClient.post(`/orders/${orderId}/change-requests`, dto).then((r) => r.data),
  });
}

/**
 * Self-resolve at the stop. Always sends action=APPROVE_AT_STOP — this file has no UI
 * for APPROVE_NEXT_DELIVERY/DECLINE (that's the office/buyer-facing resolve flow, already
 * covered by web's P5-11; out of scope here).
 */
export function useResolveChangeRequestAtStop(orderId: string) {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, { crId: string }>({
    mutationFn: ({ crId }) =>
      apiClient
        .post(`/orders/${orderId}/change-requests/${crId}/resolve`, { action: "APPROVE_AT_STOP" })
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders", orderId] }),
  });
}

/**
 * Decline a still-PENDING at-door change request (action=DECLINE, reason required
 * by the server). Used to clean up an orphaned request whose self-resolve was
 * blocked — e.g. a regulated line the buyer isn't licensed for: `create` already
 * wrote the PENDING request (and notified the buyer) before the guard rejected at
 * `resolve`, so without this decline it would linger PENDING on the order.
 */
export function useDeclineChangeRequestAtStop(orderId: string) {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, { crId: string; reason: string }>({
    mutationFn: ({ crId, reason }) =>
      apiClient
        .post(`/orders/${orderId}/change-requests/${crId}/resolve`, { action: "DECLINE", reason })
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders", orderId] }),
  });
}
