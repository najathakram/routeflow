import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EstimateStatus = "DRAFT" | "SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CONVERTED";

export interface EstimateItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; unit?: string };
  description: string;
  qty: number;
  unitPrice: number;
  subtotal?: number;
  total?: number;
  priceType?: "STANDARD" | "SPECIAL" | "DISCOUNTED";
  originalPrice?: number;
  boxes?: number;
  pieces?: number;
}

export interface Estimate {
  id: string;
  estimateNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  status: EstimateStatus;
  expiresAt?: string;
  subtotal: number;
  taxAmount?: number;
  discount?: number;
  total: number;
  notes?: string;
  terms?: string;
  items: EstimateItem[];
  createdAt: string;
  updatedAt: string;
}

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
  return useMutation<{ invoiceId: string }, Error, string>({
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
