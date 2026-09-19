import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProductUnitPayload,
  ProductUnitLevel,
  UpdateProductUnitPayload,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { useSubscription } from "./billing";

/** The plan flag that gates the whole multi-level-units surface (server registry row). */
export const UNITS_FLAG = "flag.units_v1";

/**
 * Does the tenant's subscription serve `flag.units_v1`? Deliberately FAIL-CLOSED (unlike
 * `usePlanFlag`, which fails open for route guards): an unknown answer must never reveal an
 * editor whose every call would 403, so the surface stays hidden until the flag is confirmed.
 */
export function useUnitsEnabled(): boolean {
  const q = useSubscription({ staleTime: 60_000 });
  return q.data?.flags?.includes(UNITS_FLAG as never) === true;
}

const key = (productId: string) => ["products", productId, "units"] as const;

export function useProductUnits(productId: string, enabled: boolean) {
  return useQuery<ProductUnitLevel[]>({
    queryKey: key(productId),
    queryFn: () => apiClient.get(`/products/${productId}/units`).then((r) => r.data),
    enabled: enabled && !!productId,
  });
}

function useInvalidate(productId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key(productId) });
}

export function useCreateProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: (body: CreateProductUnitPayload) =>
      apiClient.post(`/products/${productId}/units`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProductUnitPayload & { id: string }) =>
      apiClient.patch(`/products/${productId}/units/${id}`, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteProductUnit(productId: string) {
  const invalidate = useInvalidate(productId);
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete(`/products/${productId}/units/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
}
