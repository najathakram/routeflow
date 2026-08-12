import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CreateAuthorizationInput, CreateOverrideInput } from "../authorizations-logic";
import type { AuthorizationSource, AuthorizationStatus } from "../customer-authorizations-logic";

/**
 * Operator regulated-license (authorization) hooks — capture a customer's
 * license or record a §8 override from the sale guard, plus the Wave-4
 * customer-file surface: list, approve, reject, renew, expiring-soon.
 * Mirrors web `lib/api/authorizations.ts`.
 *
 * The pure helpers/types (parseRegulatedAuthError, overrideScope, OVERRIDE_REASONS,
 * BlockedCategory, …) live in ../authorizations-logic and are re-exported here so
 * callers have a single import surface.
 */
export * from "../authorizations-logic";

const authKey = (customerId: string) => ["customers", customerId, "authorizations"] as const;

export interface CustomerAuthorization {
  id: string;
  customerId: string;
  trackedCategoryId: string;
  status: AuthorizationStatus;
  source: AuthorizationSource;
  licenseNumber: string | null;
  expiresAt: string | null;
  documentKey: string | null;
  verifiedById: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  trackedCategory: { id: string; name: string; requiresLicense: boolean };
}

/** All authorization rows on a customer's file, newest first. */
export function useCustomerAuthorizations(customerId: string) {
  return useQuery<CustomerAuthorization[]>({
    queryKey: authKey(customerId),
    queryFn: () => apiClient.get(`/customers/${customerId}/authorizations`).then((r) => r.data),
    enabled: !!customerId,
  });
}

/** Capture a customer license for a category (POST /customers/:id/authorizations → VERIFIED). */
export function useCreateAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreateAuthorizationInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/authorizations`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** PENDING_REVIEW → VERIFIED (buyer-submitted license accepted). */
export function useApproveAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerAuthorization, Error, string>({
    mutationFn: (aid) =>
      apiClient.post(`/customers/${customerId}/authorizations/${aid}/approve`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** PENDING_REVIEW → REJECTED; the optional reason goes to the audit log. */
export function useRejectAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerAuthorization, Error, { aid: string; reason?: string }>({
    mutationFn: ({ aid, reason }) =>
      apiClient
        .post(`/customers/${customerId}/authorizations/${aid}/reject`, { reason })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** Re-verify a VERIFIED/EXPIRED license with a fresh number/expiry. */
export function useRenewAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<
    CustomerAuthorization,
    Error,
    { aid: string; licenseNumber?: string; expiresAt?: string; documentKey?: string }
  >({
    mutationFn: ({ aid, ...data }) =>
      apiClient
        .post(`/customers/${customerId}/authorizations/${aid}/renew`, data)
        .then((r) => r.data),
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

/** A license expiring soon (30/7/1 windows) or already expired. */
export interface ExpiringAuthorization {
  id: string;
  customerId: string;
  customerName: string;
  trackedCategoryId: string;
  categoryName: string;
  status: "VERIFIED" | "EXPIRED";
  expiresAt: string | null;
  bucket: 30 | 7 | 1 | null;
  expired: boolean;
}

/** Tenant-wide expiring/expired licenses — mirrors web's header expiry bell. */
export function useExpiringAuthorizations() {
  return useQuery<ExpiringAuthorization[]>({
    queryKey: ["authorizations", "expiring"],
    queryFn: () => apiClient.get("/authorizations/expiring-soon").then((r) => r.data),
    staleTime: 60 * 1000,
  });
}
