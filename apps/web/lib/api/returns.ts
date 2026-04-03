import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReturnStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "IN_TRANSIT"
  | "RECEIVED"
  | "REFUNDED"
  | "CANCELLED"
  | "PROCESSED";

export type ReturnReason =
  | "DAMAGED"
  | "WRONG_ITEM"
  | "EXCESS_ORDER"
  | "CUSTOMER_REFUSED"
  | "QUALITY_ISSUE";

export interface ReturnItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit?: string };
  orderedQty: number;
  unitPrice?: number | null;
  qty: number;
  condition?: string;
  notes?: string;
  restock?: boolean;
}

export interface ReturnLog {
  id: string;
  status: ReturnStatus;
  notes?: string;
  createdAt: string;
}

export interface Return {
  id: string;
  returnNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string };
  orderId: string;
  order?: { id: string; orderNumber: string };
  status: ReturnStatus;
  reason: ReturnReason;
  notes?: string;
  items: ReturnItem[];
  logs?: ReturnLog[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useReturns(params?: {
  status?: string;
  reason?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<Return>>({
    queryKey: ["returns", params],
    queryFn: () => apiClient.get("/returns", { params }).then((r) => r.data),
  });
}

export function useReturn(id: string) {
  return useQuery<Return>({
    queryKey: ["returns", id],
    queryFn: () => apiClient.get(`/returns/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateReturnItemDto {
  productId: string;
  qty: number;
  notes?: string;
  restock?: boolean;
}

export interface CreateReturnDto {
  customerId: string;
  orderId: string;
  reason: ReturnReason;
  notes?: string;
  items: CreateReturnItemDto[];
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, CreateReturnDto>({
    mutationFn: (dto) => apiClient.post("/returns", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["returns"] }),
  });
}

export function useApproveReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: (id) => apiClient.post(`/returns/${id}/approve`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}

export function useRejectReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: (id) => apiClient.post(`/returns/${id}/reject`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}

export function useMarkReturnInTransit() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: (id) => apiClient.post(`/returns/${id}/in-transit`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}

export function useMarkReturnReceived() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: (id) => apiClient.post(`/returns/${id}/receive`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}

export interface ProcessRefundDto {
  id: string;
  restock?: boolean;
}

export function useProcessRefund() {
  const qc = useQueryClient();
  return useMutation<Return, Error, ProcessRefundDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/returns/${id}/refund`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}
