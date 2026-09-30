import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CrmStatusResponse,
  CrmConfigPatch,
  CrmHandoffRow,
  CrmSyncCounts,
  CrmPipeline,
  CrmTestConnectionResult,
} from "@routeflow/types";
import { apiClient } from "../api-client";

// ─── CRM (GoHighLevel lead handoff) — 2026-09-11-crm-gohighlevel-handoff (WP4) ────────────────
//
// One shared query key root (`["crm", "gohighlevel"]`) so every mutation below can invalidate
// the whole surface with a single call — the tab always re-fetches status + handoffs together
// rather than juggling per-field invalidations. See spec.md R1-R8, R22-R24.

export const crmStatusKey = ["crm", "gohighlevel"] as const;
export const crmHandoffsKey = (params?: { status?: string; page?: number; limit?: number }) =>
  ["crm", "gohighlevel", "handoffs", params ?? {}] as const;
export const crmPipelinesKey = ["crm", "gohighlevel", "pipelines"] as const;

// Envelope shape per the fix-plan Shared Contracts section:
// `CrmConnectionService.listHandoffs` returns `{data, total, page, limit}` (limit clamped to 100).
export interface CrmHandoffsResult {
  data: CrmHandoffRow[];
  total: number;
  page: number;
  limit: number;
}

export interface CrmImportPreview {
  count: number;
  sample: Array<{
    opportunityName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
  }>;
}

function invalidateCrm(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: crmStatusKey });
}

export function useCrmStatus(options?: { enabled?: boolean }) {
  return useQuery<CrmStatusResponse>({
    queryKey: crmStatusKey,
    queryFn: () => apiClient.get("/crm/gohighlevel").then((r) => r.data),
    enabled: options?.enabled,
  });
}

export function useCrmPipelines(options?: { enabled?: boolean }) {
  return useQuery<CrmPipeline[]>({
    queryKey: crmPipelinesKey,
    queryFn: () => apiClient.get("/crm/gohighlevel/pipelines").then((r) => r.data),
    enabled: options?.enabled,
  });
}

export function useCrmHandoffs(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<CrmHandoffsResult>({
    queryKey: crmHandoffsKey(params),
    queryFn: () => apiClient.get("/crm/gohighlevel/handoffs", { params }).then((r) => r.data),
  });
}

export function useSaveCrmConnection() {
  const qc = useQueryClient();
  return useMutation<CrmStatusResponse, Error, { token: string; locationId: string }>({
    mutationFn: (body) => apiClient.patch("/crm/gohighlevel/connection", body).then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useTestCrmConnection() {
  const qc = useQueryClient();
  return useMutation<CrmTestConnectionResult, Error, void>({
    mutationFn: () => apiClient.post("/crm/gohighlevel/connection/test").then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useDisconnectCrm() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => apiClient.delete("/crm/gohighlevel/connection").then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useUpdateCrmConfig() {
  const qc = useQueryClient();
  return useMutation<CrmStatusResponse, Error, CrmConfigPatch>({
    mutationFn: (body) => apiClient.patch("/crm/gohighlevel/config", body).then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useSyncCrmNow() {
  const qc = useQueryClient();
  return useMutation<CrmSyncCounts, Error, void>({
    mutationFn: () => apiClient.post("/crm/gohighlevel/sync").then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function usePreviewCrmImport() {
  return useMutation<CrmImportPreview, Error, void>({
    mutationFn: () =>
      apiClient.post("/crm/gohighlevel/import-existing/preview").then((r) => r.data),
  });
}

export function useImportExistingCrmLeads() {
  const qc = useQueryClient();
  return useMutation<CrmSyncCounts, Error, void>({
    mutationFn: () => apiClient.post("/crm/gohighlevel/import-existing").then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useRetryHandoff() {
  const qc = useQueryClient();
  return useMutation<{ status: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/crm/gohighlevel/handoffs/${id}/retry`).then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useDismissHandoff() {
  const qc = useQueryClient();
  return useMutation<{ status: string }, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/crm/gohighlevel/handoffs/${id}/dismiss`).then((r) => r.data),
    onSuccess: () => invalidateCrm(qc),
  });
}
