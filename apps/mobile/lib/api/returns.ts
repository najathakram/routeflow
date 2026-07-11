import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReturnReason =
  | "DAMAGED"
  | "WRONG_ITEM"
  | "CUSTOMER_REFUSED"
  | "QUALITY_ISSUE"
  | "EXCESS_ORDER";

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
  creditNoteId?: string;
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

export interface CreateReturnItemDto {
  productId: string;
  qty: number;
  /** Optional per-item reason (defaults to the return's top-level reason server-side). */
  reason?: ReturnReason;
  /** Whether to add the returned qty back to stock on receive (default true). */
  restock?: boolean;
}

export interface CreateReturnDto {
  orderId: string;
  reason: ReturnReason;
  notes?: string;
  items: CreateReturnItemDto[];
  photoUrls?: string[];
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, CreateReturnDto>({
    mutationFn: (dto) => apiClient.post("/returns", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["returns"] }),
  });
}

function returnTransition(
  action: "approve" | "reject" | "in-transit" | "receive" | "refund" | "cancel",
) {
  // These endpoints take no body — the server ignores any payload. The restock
  // decision is fixed per-item at CREATE time (ReturnItem.restock), so there is
  // no restock flag to send here.
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
export const useReceiveReturn = () => useReturnTransition("receive");
export const useRefundReturn = () => useReturnTransition("refund");
export const useCancelReturn = () => useReturnTransition("cancel");
