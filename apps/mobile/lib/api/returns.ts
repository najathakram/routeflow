import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CreateReturnItemDto } from "@routeflow/types";
export type { CreateReturnItemDto } from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReturnReason =
  "DAMAGED" | "WRONG_ITEM" | "CUSTOMER_REFUSED" | "QUALITY_ISSUE" | "EXCESS_ORDER";

export type ReturnStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "IN_TRANSIT"
  | "RECEIVED"
  | "REFUNDED"
  | "PROCESSED"
  | "CANCELLED";

export interface ReturnItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit?: string };
  /** Enriched at read time from the source order line (not a column). */
  orderedQty?: number;
  unitPrice?: number | null;
  qty: number;
  reason?: ReturnReason;
  restock?: boolean;
}

export type RefundMethod = "CREDIT_NOTE" | "EXTERNAL_REFUND";

export interface Return {
  id: string;
  returnNumber?: string;
  orderId: string;
  order?: { id: string; orderNumber: string };
  customerId?: string;
  customer?: { id: string; businessName: string; contactName?: string };
  reason: ReturnReason;
  status: ReturnStatus;
  notes?: string;
  /** Populated once a CREDIT_NOTE refund has minted store credit for this return. */
  creditNoteId?: string;
  creditNote?: { id: string; creditNoteNumber: string; amount: number; status: string };
  refundAmount?: number | null;
  refundMethod?: RefundMethod | null;
  refundedAt?: string | null;
  /**
   * Server-computed Σ qty × (subtotal/qty) across the return's items — the same
   * box-price-safe figure processRefund would mint/record. Always present so the
   * UI can show the amount before the operator commits to a resolve method.
   */
  refundEstimate?: number;
  items: ReturnItem[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyReturns(params?: { status?: string }) {
  return useQuery<PaginatedResponse<Return>>({
    queryKey: ["returns", "mine", params],
    queryFn: () => apiClient.get("/returns", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyReturn(id: string) {
  return useQuery<Return>({
    queryKey: ["returns", id],
    queryFn: () => apiClient.get(`/returns/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/** Alias for the detail screen — GET /returns/:id is role-agnostic server-side. */
export const useReturn = useMyReturn;

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateReturnDto {
  orderId: string;
  reason: ReturnReason;
  notes?: string;
  items: CreateReturnItemDto[];
  photoUrls?: string[];
  /**
   * Sent as the `Idempotency-Key` HEADER (never in the body — the server reads it off the
   * header only, `returns.controller.ts`). A duplicate POST under the same key — a remounted
   * screen, a deliberate re-issue, an offline-queue replay — returns the ORIGINAL return
   * instead of creating a second one, which is what keeps a retry from double-crediting the
   * customer. Derive it with `lib/return-submit-key#returnSubmitKey`.
   */
  idempotencyKey?: string;
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, CreateReturnDto>({
    // `idempotencyKey` travels as a HEADER, never in the body (the same idiom as
    // `useCreateOrderAsDriver` in lib/api/orders.ts) — api-client also preserves that header
    // across an offline-queue replay, so a replayed return collapses onto the original
    // instead of minting a second credit.
    mutationFn: ({ idempotencyKey, ...body }) =>
      apiClient
        .post(
          "/returns",
          body,
          idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {},
        )
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["returns"] }),
  });
}

function returnTransition(action: "approve" | "reject" | "in-transit" | "cancel") {
  // These endpoints take no body — the server ignores any payload.
  return (id: string) => apiClient.post(`/returns/${id}/${action}`).then((r) => r.data as Return);
}

/** Build a transition hook that invalidates both the list and the per-id detail. */
function useReturnTransition(action: Parameters<typeof returnTransition>[0]) {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition(action),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
      qc.invalidateQueries({ queryKey: ["admin", "returns"] });
    },
  });
}

export const useApproveReturn = () => useReturnTransition("approve");
export const useRejectReturn = () => useReturnTransition("reject");
export const useMarkReturnInTransit = () => useReturnTransition("in-transit");
export const useCancelReturn = () => useReturnTransition("cancel");

// ─── Receive & refund (take bodies) ────────────────────────────────────────────

/**
 * Accepts either a bare id (today's "just mark received, keep the per-item
 * restock flags from create time" behavior — the returns list's quick action
 * still calls it this way) or `{ id, restock }` for the "resolve without
 * receiving" flow, which suppresses restocking entirely.
 */
export type ReceiveReturnInput = string | { id: string; restock?: boolean };

export function useReceiveReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, ReceiveReturnInput>({
    mutationFn: (input) => {
      const id = typeof input === "string" ? input : input.id;
      const restock = typeof input === "string" ? undefined : input.restock;
      const data = restock === undefined ? {} : { restock };
      return apiClient.post(`/returns/${id}/receive`, data).then((r) => r.data as Return);
    },
    onSuccess: (_, input) => {
      const id = typeof input === "string" ? input : input.id;
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
      qc.invalidateQueries({ queryKey: ["admin", "returns"] });
    },
  });
}

export interface RefundReturnDto {
  id: string;
  /** CREDIT_NOTE (default) mints store credit; EXTERNAL_REFUND records nothing minted. */
  method?: RefundMethod;
}

export function useRefundReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, RefundReturnDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/returns/${id}/refund`, data).then((r) => r.data as Return),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["returns"] });
      qc.invalidateQueries({ queryKey: ["returns", id] });
      qc.invalidateQueries({ queryKey: ["admin", "returns"] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
    },
  });
}
