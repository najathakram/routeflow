import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReadyForPickupResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

/** POST /orders/:id/ready-for-pickup (W-1043): the staff "Ready for pickup" step. The answer says what happened to the email. */
export function useReadyForPickup() {
  const qc = useQueryClient();
  return useMutation<ReadyForPickupResponse, Error, string>({
    mutationFn: (id) =>
      apiClient.post<ReadyForPickupResponse>(`/orders/${id}/ready-for-pickup`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", id] });
    },
  });
}
