import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface ZohoStatus {
  configured: boolean;
  lastSync: string | null;
}

export interface ZohoConfig {
  clientId: string | null;
  region: string;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

export interface ZohoSyncResult {
  synced: number;
  created: number;
  updated: number;
}

export function useZohoStatus() {
  return useQuery<ZohoStatus>({
    queryKey: ["zoho-status"],
    queryFn: () => apiClient.get("/zoho-sync/status").then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useZohoConfig() {
  return useQuery<ZohoConfig>({
    queryKey: ["zoho-config"],
    queryFn: () => apiClient.get("/zoho-sync/config").then((r) => r.data),
  });
}

export function useUpdateZohoConfig() {
  const qc = useQueryClient();
  return useMutation<{ message: string }, Error, { clientId?: string; clientSecret?: string; refreshToken?: string; region?: string }>({
    mutationFn: (dto) => apiClient.patch("/zoho-sync/config", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zoho-config"] });
      qc.invalidateQueries({ queryKey: ["zoho-status"] });
    },
  });
}

export function useZohoSync() {
  const qc = useQueryClient();
  return useMutation<ZohoSyncResult, Error, void>({
    mutationFn: () => apiClient.post("/zoho-sync").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["zoho-status"] });
    },
  });
}
