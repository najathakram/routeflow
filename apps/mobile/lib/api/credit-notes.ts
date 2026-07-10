import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/web/lib/api/credit-notes.ts) ────────────────────────────

// Web type has 4 values; the DB enum has only ISSUED|APPLIED|VOID (DRAFT never
// occurs — create always writes ISSUED). Mirrored for 1:1 parity with web.
export type CreditNoteStatus = "DRAFT" | "ISSUED" | "APPLIED" | "VOID";

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  invoiceId?: string;
  status: CreditNoteStatus;
  issueDate?: string;
  amount: number;
  reason?: string;
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
    staleTime: 60_000,
  });
}

export function useCreditNote(id: string) {
  return useQuery<CreditNote>({
    queryKey: ["credit-notes", id],
    queryFn: () => apiClient.get(`/credit-notes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/**
 * Open invoices for a customer — backs the Apply-to-Invoice picker (mirrors the
 * web ApplyToInvoiceModal). `GET /invoices` supports a `customerId` filter (see
 * the invoices controller `@Query("customerId")`); this is a query-param
 * passthrough, not a new model.
 */
export function useOpenInvoicesForCustomer(customerId?: string) {
  return useQuery<{
    data: Array<{ id: string; invoiceNumber: string; status: string; total: number }>;
  }>({
    queryKey: ["invoices", { customerId, limit: 100 }],
    queryFn: () =>
      apiClient.get("/invoices", { params: { customerId, limit: 100 } }).then((r) => r.data),
    enabled: !!customerId,
  });
}

// ─── Mutations (status transitions — credit notes are create-only server-side) ──

function invalidateCreditNote(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["credit-notes"] });
  qc.invalidateQueries({ queryKey: ["credit-notes", id] });
}

/** Issue == server no-op (service.issue() returns findOne; no status change). */
export function useIssueCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, string>({
    mutationFn: (id) => apiClient.post(`/credit-notes/${id}/issue`).then((r) => r.data),
    onSuccess: (_, id) => invalidateCreditNote(qc, id),
  });
}

/**
 * Apply the full credit to an invoice. The server returns the UPDATED INVOICE
 * (keyed `id`), NOT the credit note — the web hook's `CreditNote` type is wrong.
 * The detail screen navigates to `/(operator)/invoices/${inv.id}`. Web never
 * sends `amount` (always full apply), so neither do we.
 */
export function useApplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, { id: string; invoiceId: string }>({
    mutationFn: ({ id, invoiceId }) =>
      apiClient.post(`/credit-notes/${id}/apply`, { invoiceId }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateCreditNote(qc, id);
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

/** Void — server rejects if APPLIED or amountUsed>0; undoes any ledger reversal. */
export function useVoidCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, string>({
    mutationFn: (id) => apiClient.post(`/credit-notes/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => invalidateCreditNote(qc, id),
  });
}
