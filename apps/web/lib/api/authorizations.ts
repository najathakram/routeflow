import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

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
