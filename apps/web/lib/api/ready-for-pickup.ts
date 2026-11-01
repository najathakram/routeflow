import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReadyForPickupRecord, ReadyForPickupResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

/** What the press sends: the order id, plus `resend` for "Send again" (W-1060). A bare id is a plain press. */
export type ReadyForPickupVars = string | { id: string; resend?: boolean };

/** POST /orders/:id/ready-for-pickup (W-1043): the staff "Ready for pickup" step. The answer says what happened to the email. */
export function useReadyForPickup() {
  const qc = useQueryClient();
  return useMutation<ReadyForPickupResponse, Error, ReadyForPickupVars>({
    mutationFn: (vars) => {
      const { id, resend } = typeof vars === "string" ? { id: vars, resend: false } : vars;
      const url = `/orders/${id}/ready-for-pickup`;
      // a plain press posts no body (older tills and phones post none either)
      return (
        resend
          ? apiClient.post<ReadyForPickupResponse>(url, { resend: true })
          : apiClient.post<ReadyForPickupResponse>(url)
      ).then((r) => r.data);
    },
    onSuccess: (_, vars) => {
      const id = typeof vars === "string" ? vars : vars.id;
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", id] });
      qc.invalidateQueries({ queryKey: ["orders", id, "ready-record"] });
    },
  });
}

/** GET /orders/:id/ready-for-pickup (W-1060): the last ready email and what a press would do now. Staff pickup orders only. */
export function useReadyForPickupRecord(orderId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["orders", orderId, "ready-record"],
    queryFn: () =>
      apiClient
        .get<ReadyForPickupRecord>(`/orders/${orderId}/ready-for-pickup`)
        .then((r) => r.data),
    enabled: enabled && !!orderId,
  });
}
