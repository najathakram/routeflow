import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { Estimate, EstimateStatus } from "@routeflow/types";

// ─── Types (mirror apps/web/lib/api/estimates.ts) ───────────────────────────────

/**
 * Wave E / imp-10b, L-072 (sibling-sweep find): was a hand-typed local union
 * with a phantom `"EXPIRED"` value the Prisma schema has never had
 * (`DRAFT|SENT|ACCEPTED|DECLINED|CONVERTED`) — the API can never return it, so
 * every `case "EXPIRED"` branch reading this type was dead code. Now imported
 * from `@routeflow/types`, pinned to the schema by `enum-parity.spec.ts`.
 */
export type { Estimate, EstimateItem, EstimateStatus } from "@routeflow/types";

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useEstimates(params?: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<Estimate>>({
    queryKey: ["estimates", params],
    queryFn: () => apiClient.get("/estimates", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useEstimate(id: string) {
  return useQuery<Estimate>({
    queryKey: ["estimates", id],
    queryFn: () => apiClient.get(`/estimates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations (status transitions — estimates are create-only server-side) ─────

function invalidateEstimate(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["estimates"] });
  qc.invalidateQueries({ queryKey: ["estimates", id] });
}

export function useSendEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => invalidateEstimate(qc, id),
  });
}

export function useAcceptEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/accept`).then((r) => r.data),
    onSuccess: (_, id) => invalidateEstimate(qc, id),
  });
}

export function useDeclineEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/decline`).then((r) => r.data),
    onSuccess: (_, id) => invalidateEstimate(qc, id),
  });
}

/**
 * Convert an ACCEPTED estimate into a DRAFT invoice. The server returns the full
 * created Invoice (keyed `id` — the web hook's `{ invoiceId }` type is wrong), so
 * the detail screen navigates to `/(operator)/invoices/${inv.id}`.
 */
export function useConvertEstimateToInvoice() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/convert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

/** Void == server sets status DECLINED; rejected once CONVERTED. */
export function useVoidEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => invalidateEstimate(qc, id),
  });
}
