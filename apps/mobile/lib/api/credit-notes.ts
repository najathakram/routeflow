import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CreditNoteStatus = "ISSUED" | "APPLIED" | "VOID";

export interface CreditNoteItem {
  id: string;
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
}

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  status: CreditNoteStatus;
  amount: number;
  reason?: string;
  notes?: string;
  orderId?: string;
  invoiceId?: string;
  items?: CreditNoteItem[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyCreditNotes(params?: { status?: CreditNoteStatus; page?: number }) {
  return useQuery<PaginatedResponse<CreditNote>>({
    queryKey: ["credit-notes", "mine", params],
    queryFn: () => apiClient.get("/credit-notes", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyCreditNote(id: string) {
  return useQuery<CreditNote>({
    queryKey: ["credit-notes", id],
    queryFn: () => apiClient.get(`/credit-notes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}
