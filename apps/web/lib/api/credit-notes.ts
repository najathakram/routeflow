import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CreditNoteStatus = "DRAFT" | "ISSUED" | "APPLIED" | "VOID";

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  invoiceId?: string;
  status: CreditNoteStatus;
  issueDate: string;
  amount: number;
  reason: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useCreditNotes(params?: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<CreditNote>>({
    queryKey: ["credit-notes", params],
    queryFn: () => apiClient.get("/credit-notes", { params }).then((r) => r.data),
  });
}

export function useCreditNote(id: string) {
  return useQuery<CreditNote>({
    queryKey: ["credit-notes", id],
    queryFn: () => apiClient.get(`/credit-notes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateCreditNoteDto {
  customerId: string;
  invoiceId?: string;
  amount: number;
  reason: string;
  issueDate: string;
  notes?: string;
}

export function useCreateCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, CreateCreditNoteDto>({
    mutationFn: (dto) => apiClient.post("/credit-notes", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credit-notes"] }),
  });
}

export function useIssueCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, string>({
    mutationFn: (id) => apiClient.post(`/credit-notes/${id}/issue`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
    },
  });
}

export function useApplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string; invoiceId: string }>({
    mutationFn: ({ id, invoiceId }) =>
      apiClient.post(`/credit-notes/${id}/apply`, { invoiceId }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export function useVoidCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, string>({
    mutationFn: (id) => apiClient.post(`/credit-notes/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
    },
  });
}
