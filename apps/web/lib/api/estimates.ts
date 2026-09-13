import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { Estimate, EstimateStatus } from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Wave E / imp-10b, L-072 (sibling-sweep find): was a hand-typed local union
 * with a phantom `"EXPIRED"` value the Prisma schema has never had — now
 * imported from `@routeflow/types`, pinned to the schema by `enum-parity.spec.ts`.
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
  });
}

export function useEstimate(id: string) {
  return useQuery<Estimate>({
    queryKey: ["estimates", id],
    queryFn: () => apiClient.get(`/estimates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateEstimateItem {
  productId?: string;
  description: string;
  qty: number;
  unitPrice?: number;
  boxes?: number;
  pieces?: number;
}

export interface CreateEstimateDto {
  customerId: string;
  expiresAt?: string;
  items: CreateEstimateItem[];
  notes?: string;
  terms?: string;
}

export function useCreateEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, CreateEstimateDto>({
    mutationFn: (dto) => apiClient.post("/estimates", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["estimates"] }),
  });
}

export function useSendEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useAcceptEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/accept`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useDeclineEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/decline`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useConvertEstimateToInvoice() {
  const qc = useQueryClient();
  // Server returns the created Invoice keyed `id` (B15-NAV) — not `invoiceId`.
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/convert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export function useVoidEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}
