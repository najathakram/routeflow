import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  BulkSetPortalVisibilityPayload,
  BulkSetPortalVisibilityResult,
} from "@routeflow/types";

// Buyer-portal visibility (hide a product from buyers). TENANT_ADMIN-only, server-enforced.
// No error toasts here: the global MutationCache handler shows the server message once (B594).

function useInvalidateProducts() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["products"] });
}

export function useSetProductPortalVisibility(productId: string) {
  const invalidate = useInvalidateProducts();
  return useMutation<unknown, Error, { portalVisible: boolean }>({
    mutationFn: (dto) =>
      apiClient.patch(`/products/${productId}/portal-visibility`, dto).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useBulkSetPortalVisibility() {
  const invalidate = useInvalidateProducts();
  return useMutation<BulkSetPortalVisibilityResult, Error, BulkSetPortalVisibilityPayload>({
    mutationFn: (dto) => apiClient.patch("/products/portal-visibility", dto).then((r) => r.data),
    onSuccess: invalidate,
  });
}
