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
  /** Dollars already consumed against this credit (Σ non-VOID CREDIT_NOTE payments). */
  amountUsed?: number;
  reason?: string;
  notes?: string;
  expiresAt?: string | null;
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
  /** Scope to one customer's credits — backs the order picker. */
  customerId?: string;
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
 * Every invoice for a customer, any status — backs both the Apply-to-Invoice
 * picker (mirrors the web ApplyToInvoiceModal; OPEN-status filter applied
 * client-side there) and the new-credit-note invoice picker (which only
 * excludes VOID/WRITTEN_OFF). `GET /invoices` supports a `customerId` filter
 * (see the invoices controller `@Query("customerId")`); this is a query-param
 * passthrough, not a new model.
 */
export function useInvoicesForCustomer(customerId?: string) {
  return useQuery<{
    data: Array<{ id: string; invoiceNumber: string; status: string; total: number }>;
  }>({
    queryKey: ["invoices", { customerId, limit: 100 }],
    queryFn: () =>
      apiClient.get("/invoices", { params: { customerId, limit: 100 } }).then((r) => r.data),
    enabled: !!customerId,
  });
}

/** Old name kept as an alias — [id].tsx's ApplyInvoicePicker still imports this. */
export const useOpenInvoicesForCustomer = useInvoicesForCustomer;

// ─── Mutations (create + status transitions) ─────────────────────────────────

export interface CreateCreditNoteInput {
  customerId: string;
  amount: number;
  /** Required by the create screen's own validation; optional on the wire. */
  reason?: string;
  /** Optional source invoice. Absent = a standalone credit for this customer. */
  invoiceId?: string;
  /** ISO date; the service additionally requires it to be in the future. */
  expiresAt?: string;
}

/**
 * Create a standalone (or invoice-linked) credit note. The service needs no
 * invoice and runs no "does this customer have orders" check — any customer
 * can receive a credit — mirroring apps/web/lib/api/credit-notes.ts.
 */
export function useCreateCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, CreateCreditNoteInput>({
    mutationFn: (dto) => apiClient.post("/credit-notes", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credit-notes"] }),
  });
}

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

/**
 * Un-apply a credit note from one invoice: restores the pair's dollars to the
 * wallet, reverts the credit's status, and recomputes the invoice's status.
 */
export function useUnapplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string; invoiceId: string }>({
    mutationFn: ({ id, invoiceId }) =>
      apiClient.post(`/credit-notes/${id}/unapply`, { invoiceId }).then((r) => r.data),
    onSuccess: (_, { id, invoiceId }) => {
      invalidateCreditNote(qc, id);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      // The operator invoice/order detail screens read via `lib/api/admin.ts`'s
      // own query keys — invalidate those too so the unapply reflects there.
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
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
