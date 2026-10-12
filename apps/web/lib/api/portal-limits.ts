import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  BulkRestrictionRequest,
  BulkRestrictionResponse,
  LiftBatchRequest,
  ProductLimitDto,
} from "../portal-limits";

const RULES = ["selling-restrictions"] as const;

/**
 * Limit N products / one category in the portal (TENANT_ADMIN). No `onError`: the dialog renders its own footer
 * sentence, so the mutation opts out of the global toast (a second message would double it).
 */
export function useBulkLimit() {
  const qc = useQueryClient();
  return useMutation<BulkRestrictionResponse, Error, BulkRestrictionRequest>({
    meta: { localErrorToast: true },
    mutationFn: (body) => apiClient.post("/selling-restrictions/bulk", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES }),
  });
}

/** Lift a batch (one reason). The Undo toast, "Lift N" on the rules page and a chip's Lift all use this. */
export function useLiftBatch() {
  const qc = useQueryClient();
  return useMutation<{ lifted: number }, Error, LiftBatchRequest>({
    mutationFn: (body) =>
      apiClient.post("/selling-restrictions/lift-batch", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES }),
  });
}

/** The rules binding one product, with where each came from (`via`). */
export function useProductLimits(productId: string) {
  return useQuery<ProductLimitDto[]>({
    queryKey: [...RULES, "product", productId],
    queryFn: () =>
      apiClient.get("/selling-restrictions", { params: { productId } }).then((r) => r.data),
    enabled: !!productId,
  });
}

/**
 * The same lift as `useLiftBatch`, as a plain call. A toast's Undo outlives the component that raised it (the selection
 * is cleared, the dialog unmounts), and a hook's per-call callbacks do not run on an unmounted observer.
 */
export async function liftBatchRequest(body: LiftBatchRequest): Promise<{ lifted: number }> {
  const { data } = await apiClient.post("/selling-restrictions/lift-batch", body);
  return data;
}
