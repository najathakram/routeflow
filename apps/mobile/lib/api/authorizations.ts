import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CreateAuthorizationInput, CreateOverrideInput } from "../authorizations-logic";

/**
 * Operator regulated-license (authorization) hooks — the guard that lets an
 * operator capture a customer's license or record a §8 override when a
 * regulated sale is blocked. Mirrors web `lib/api/authorizations.ts`.
 *
 * The pure helpers/types (parseRegulatedAuthError, overrideScope, OVERRIDE_REASONS,
 * BlockedCategory, …) live in ../authorizations-logic and are re-exported here so
 * callers have a single import surface.
 */
export * from "../authorizations-logic";

const authKey = (customerId: string) => ["customers", customerId, "authorizations"] as const;

/** Capture a customer license for a category (POST /customers/:id/authorizations → VERIFIED). */
export function useCreateAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreateAuthorizationInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/authorizations`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** Record a §8 override (POST /customers/:id/authorization-overrides). */
export function useCreateAuthorizationOverride(customerId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreateOverrideInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/authorization-overrides`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}
