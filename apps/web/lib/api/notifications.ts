import { useQuery, useMutation } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface NotificationsStatus {
  configured: boolean;
  deviceCount: number;
}

export interface TestNotificationResult {
  sent: number;
  deviceCount: number;
}

export function useNotificationsStatus() {
  return useQuery<NotificationsStatus>({
    queryKey: ["notifications-status"],
    queryFn: () => apiClient.get("/notifications/status").then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useSendTestNotification() {
  return useMutation<TestNotificationResult, Error, void>({
    mutationFn: () => apiClient.post("/notifications/test").then((r) => r.data),
  });
}
