import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthorizationStatus = "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";
export type AuthorizationSource = "RETAILER_SUBMITTED" | "WHOLESALER_ADDED";

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

/** The shape of a blocked category inside a 409 REGULATED_AUTH_REQUIRED body. */
export interface BlockedCategory {
  trackedCategoryId: string;
  categoryName: string;
  reason: "NO_AUTH" | "EXPIRED";
}

export interface CreateAuthorizationInput {
  trackedCategoryId: string;
  licenseNumber?: string;
  expiresAt?: string; // ISO 8601
  documentKey?: string;
}

export interface RenewAuthorizationInput {
  licenseNumber?: string;
  expiresAt?: string; // ISO 8601
  documentKey?: string;
}

export interface CreateOverrideInput {
  trackedCategoryId: string;
  reason: string;
  scope: string; // "ORDER:<id>" | "UNTIL:<iso>"
  acknowledgedTenant: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const authKey = (customerId: string) => ["customers", customerId, "authorizations"] as const;

/**
 * Read a 409 REGULATED_AUTH_REQUIRED body off a thrown AxiosError. Returns the
 * blocked categories (possibly empty) when this is the license-guard 409, else
 * null. Mirrors lib/plan-gate.parsePlanGate. Shared by the order-builder create
 * flow and the order-detail edit/promote flow.
 */
export function parseRegulatedAuthError(err: unknown): BlockedCategory[] | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; blockedCategories?: BlockedCategory[] };
      };
    }
  )?.response;
  if (res?.status === 409 && res.data?.code === "REGULATED_AUTH_REQUIRED") {
    return res.data.blockedCategories ?? [];
  }
  return null;
}

/**
 * Lazy-expiry display status: a VERIFIED authorization past its `expiresAt` reads
 * as EXPIRED (matches the sale guard + buyer gate; the W7 cron flips the persisted
 * status separately).
 */
export function displayAuthStatus(a: {
  status: AuthorizationStatus;
  expiresAt: string | null;
}): AuthorizationStatus {
  if (a.status === "VERIFIED" && a.expiresAt && new Date(a.expiresAt) < new Date())
    return "EXPIRED";
  return a.status;
}

export function authStatusBadge(status: AuthorizationStatus): {
  variant: "success" | "warning" | "danger" | "info" | "neutral";
  label: string;
} {
  switch (status) {
    case "VERIFIED":
      return { variant: "success", label: "Verified" };
    case "PENDING_REVIEW":
      return { variant: "warning", label: "Pending review" };
    case "EXPIRED":
      return { variant: "danger", label: "Expired" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    case "NONE":
    default:
      return { variant: "neutral", label: "Not submitted" };
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useCustomerAuthorizations(customerId: string) {
  return useQuery<CustomerAuthorization[]>({
    queryKey: authKey(customerId),
    queryFn: () => apiClient.get(`/customers/${customerId}/authorizations`).then((r) => r.data),
    enabled: !!customerId,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Wholesaler-added: the operator captures a license → VERIFIED immediately. */
export function useCreateAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerAuthorization, Error, CreateAuthorizationInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/authorizations`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

export function useApproveAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerAuthorization, Error, string>({
    mutationFn: (aid) =>
      apiClient.post(`/customers/${customerId}/authorizations/${aid}/approve`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

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

/** Re-verify an expired/verified license with a fresh number/expiry. */
export function useRenewAuthorization(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerAuthorization, Error, { aid: string; data: RenewAuthorizationInput }>({
    mutationFn: ({ aid, data }) =>
      apiClient
        .post(`/customers/${customerId}/authorizations/${aid}/renew`, data)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** §8 "sold under seller responsibility" override — bypasses the guard for its scope. */
export function useCreateAuthorizationOverride(customerId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreateOverrideInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/authorization-overrides`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey(customerId) }),
  });
}

/** A license expiring soon (30/7/1) or already expired — W7b expiry bell. */
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

/**
 * Operator: the tenant's licenses expiring within 30 days or already expired.
 * Polled for the header expiry bell (the backend has no in-app notification store).
 */
export function useExpiringAuthorizations() {
  return useQuery<ExpiringAuthorization[]>({
    queryKey: ["authorizations", "expiring"],
    queryFn: () => apiClient.get("/authorizations/expiring-soon").then((r) => r.data),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}
