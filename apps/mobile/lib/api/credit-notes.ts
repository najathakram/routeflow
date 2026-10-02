import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreditNoteStatus,
  CreditNoteVoidPreview,
  ReissueCreditNoteInput,
  ReissueCreditNoteResult,
} from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * Credit notes are money: EVERY credit-note mutation is online-only (never offline-queued). A queued
 * apply/void/edit would replay later behind a UI that said it failed, and a retry would double it.
 * (api-client `_skipOfflineQueue`; a wiring test pins that every call in this file passes it.)
 */
const ONLINE_ONLY = { _skipOfflineQueue: true } as object;

// ─── Types (mirror apps/web/lib/api/credit-notes.ts) ────────────────────────────

// Schema-pinned (packages/types/api/enums.ts): ISSUED | APPLIED | VOID — a
// hand-typed local mirror of a server enum is how three real bugs shipped
// (L-072). DRAFT never occurs — create always writes ISSUED.
export type { CreditNoteStatus };

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
  /** #2648: the note's split across its source invoice's lines (empty for a lump-sum credit). */
  items?: Array<{ invoiceItemId: string | null; amount: number; qty: number }>;
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
    mutationFn: (dto) => apiClient.post("/credit-notes", dto, ONLINE_ONLY).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credit-notes"] }),
  });
}

function invalidateCreditNote(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["credit-notes"] });
  qc.invalidateQueries({ queryKey: ["credit-notes", id] });
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
      apiClient.post(`/credit-notes/${id}/apply`, { invoiceId }, ONLINE_ONLY).then((r) => r.data),
    onSuccess: (_, { id, invoiceId }) => {
      invalidateCreditNote(qc, id);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      // The operator invoice detail/list read lib/api/admin.ts's own keys —
      // without these, applying from the invoice screen showed a stale balance
      // until manual refetch (useUnapplyCreditNote always had them; the
      // asymmetry was an oversight).
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
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
      apiClient.post(`/credit-notes/${id}/unapply`, { invoiceId }, ONLINE_ONLY).then((r) => r.data),
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

/** #2648 / SA-535(a): reason/expiry, in place (a VOID note is not editable). */
export function useUpdateCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string; reason?: string; expiresAt?: string | null }>(
    {
      mutationFn: ({ id, ...dto }) =>
        apiClient.patch(`/credit-notes/${id}`, dto, ONLINE_ONLY).then((r) => r.data),
      onSuccess: (_, { id }) => invalidateCreditNote(qc, id),
    },
  );
}

/** What a void-with-reversal (and so a reissue) would un-apply, and any refusal. Read-only. */
export function useVoidPreview(id: string, enabled: boolean) {
  return useQuery<CreditNoteVoidPreview>({
    queryKey: ["credit-notes", id, "void-preview"],
    queryFn: () => apiClient.get(`/credit-notes/${id}/void-preview`).then((r) => r.data),
    enabled: !!id && enabled,
    staleTime: 0,
  });
}

/**
 * SA-436 PR-2 (#2402): void a credit note AFTER un-applying it everywhere (each pair is remembered
 * so the auto-apply sweep cannot re-apply it). The optional reason (#2540) is a web-dialog field.
 */
export function useVoidWithReversal() {
  const qc = useQueryClient();
  return useMutation<
    {
      creditNote: CreditNote;
      reopened: Array<{ invoiceId: string; invoiceNumber: string; amount: number }>;
    },
    Error,
    { id: string; reason?: string }
  >({
    mutationFn: ({ id, reason }) =>
      apiClient
        // Online-only: it needs a fresh void-preview, and a silent offline replay would void later.
        .post(`/credit-notes/${id}/void-with-reversal`, reason ? { reason } : {}, ONLINE_ONLY)
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateCreditNote(qc, id);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
  });
}

/** #2648 / SA-535(b): an amount/line edit — void-with-reversal + an unapplied replacement. */
export function useReissueCreditNote() {
  const qc = useQueryClient();
  return useMutation<
    ReissueCreditNoteResult<CreditNote>,
    Error,
    { id: string; idempotencyKey: string } & ReissueCreditNoteInput
  >({
    mutationFn: ({ id, idempotencyKey, ...dto }) =>
      apiClient
        // Online-only (see useVoidWithReversal): "Nothing was changed" on a network drop must be true.
        .post(`/credit-notes/${id}/reissue`, dto, {
          headers: { "Idempotency-Key": idempotencyKey },
          ...ONLINE_ONLY,
        })
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateCreditNote(qc, id);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
  });
}
