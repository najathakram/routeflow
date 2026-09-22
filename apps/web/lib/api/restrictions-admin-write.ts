import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  CreateSellingRestrictionRequest,
  SellingRestrictionListItemDto,
} from "@routeflow/types";

/**
 * Create a selling-restriction rule (TENANT_ADMIN). No `onError` here on purpose: the API's plain
 * 400/404/409 messages ("A state restriction needs at least one state.", "That category is
 * archived…") reach the user through the app's single global mutation toast — a second inline
 * message would double it. Refreshes every cached rules list (the "selling-restrictions" prefix).
 */
export function useCreateRestriction() {
  const qc = useQueryClient();
  return useMutation<SellingRestrictionListItemDto, Error, CreateSellingRestrictionRequest>({
    mutationFn: (body) => apiClient.post("/selling-restrictions", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["selling-restrictions"] }),
  });
}

/** Lift a rule now (TENANT_ADMIN). Same single-toast rule as create. */
export function useLiftRestriction() {
  const qc = useQueryClient();
  return useMutation<SellingRestrictionListItemDto, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiClient.post(`/selling-restrictions/${id}/lift`, { reason }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["selling-restrictions"] }),
  });
}
