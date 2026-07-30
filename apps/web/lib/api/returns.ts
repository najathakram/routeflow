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

export type RefundMethod = "CREDIT_NOTE" | "EXTERNAL_REFUND";

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
  /** Populated once a CREDIT_NOTE refund has minted store credit for this return. */
  creditNoteId?: string;
  creditNote?: { id: string; creditNoteNumber: string; amount: number; status: string };
  refundAmount?: number | null;
  refundMethod?: RefundMethod | null;
  refundedAt?: string | null;
  /**
   * Server-computed Σ qty × (subtotal/qty) across the return's items — the same
   * box-price-safe figure processRefund would mint/record. Always present so the
   * resolve modal can show the amount before the operator commits to a method.
   */
  refundEstimate?: number;
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

export interface MarkReceivedDto {
  id: string;
  /**
   * false = "we are not keeping these goods": the server skips restocking entirely
   * and persists restock=false on every item, so a later cancel stays symmetric.
   * Omitted/true keeps the per-item flags chosen when the return was created.
   */
  restock?: boolean;
}

export function useMarkReturnReceived() {
  const qc = useQueryClient();
  return useMutation<Return, Error, MarkReceivedDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/returns/${id}/receive`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
    },
  });
}

export interface ProcessRefundDto {
  id: string;
  /** CREDIT_NOTE (default) mints store credit; EXTERNAL_REFUND records nothing minted. */
  method?: RefundMethod;
}

export function useProcessRefund() {
  const qc = useQueryClient();
  return useMutation<Return, Error, ProcessRefundDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/returns/${id}/refund`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
    },
  });
}
