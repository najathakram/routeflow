import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  CreditNoteStatus,
  CreditNoteVoidPreview,
  ReissueCreditNoteInput,
  ReissueCreditNoteResult,
} from "@routeflow/types";
import type { LocalErrorToastOption } from "@/lib/local-error-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { CreditNoteStatus };

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  invoiceId?: string;
  /** F09/R10: the linked invoice's number, so the UI never has to show a raw UUID. */
  invoice?: { id: string; invoiceNumber: string };
  status: CreditNoteStatus;
  /** Optional on the wire in some responses — fall back to createdAt for display. */
  issueDate?: string;
  amount: number;
  /**
   * P5-13: dollars already consumed by applications (manual or auto). Open/remaining
   * balance is ALWAYS `amount - amountUsed`, never `amount` alone — a partially
   * applied ISSUED note still carries a nonzero amountUsed.
   */
  amountUsed: number;
  reason: string;
  notes?: string;
  /** P5-13: optional expiry — a computed filter, never a status flip. Past this date
   *  the note is excluded from the wallet and can no longer be applied. */
  expiresAt?: string;
  /** P5-13: stamped on first application (manual or auto). */
  appliedAt?: string;
  /** P5-13: true if any application of this note happened via auto-apply at send. */
  autoApplied?: boolean;
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

export function useCreditNotes(
  params?: {
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    /** Customer-scoped lookup — backs the order-builder credit picker. */
    customerId?: string;
    page?: number;
    limit?: number;
  },
  options?: { enabled?: boolean },
) {
  return useQuery<PaginatedResponse<CreditNote>>({
    queryKey: ["credit-notes", params],
    queryFn: () => apiClient.get("/credit-notes", { params }).then((r) => r.data),
    ...options,
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
  /**
   * @deprecated Neither field has a `CreditNote` column and the server accepts-and-ignores
   * both purely so in-flight old bundles don't 400 under `forbidNonWhitelisted`. Optional
   * here so current code never sends them — otherwise the server-side deprecation could
   * never be retired.
   */
  issueDate?: string;
  /** @deprecated See `issueDate`. */
  notes?: string;
  /**
   * Optional invoice-line linkage. Present => the credit is attributed to specific
   * invoice lines and (for regulated lines) reverses the regulated category ledger.
   * Absent => a lump-sum credit that books no regulated reversal.
   */
  items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
  /** P5-13: optional ISO date after which this credit is excluded from the wallet
   *  and can never be applied (manual or auto). Must be in the future. */
  expiresAt?: string;
}

export function useCreateCreditNote(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, CreateCreditNoteDto>({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: (dto) => apiClient.post("/credit-notes", dto).then((r) => r.data),
    // B343: the customer statement's outstanding/available-credit figures come from a
    // separate query (useCustomerStatement) that this mutation never invalidated — a
    // statement left open showed pre-credit-note numbers until an unrelated remount.
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["customers", data.customerId, "statement"] });
    },
  });
}

export function useApplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string; invoiceId: string }>({
    mutationFn: ({ id, invoiceId }) =>
      apiClient.post(`/credit-notes/${id}/apply`, { invoiceId }).then((r) => r.data),
    onSuccess: (data, { id }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers", data.customerId, "statement"] });
    },
  });
}

/**
 * Un-apply (part of) a credit note from one invoice — the inverse of
 * useApplyCreditNote. Restores the wallet balance, reverts the credit note's
 * status when it's no longer fully consumed, and reduces/removes the order's
 * stored intent so a later settle doesn't just re-apply it.
 */
export function useUnapplyCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string; invoiceId: string }>({
    mutationFn: ({ id, invoiceId }) =>
      apiClient.post(`/credit-notes/${id}/unapply`, { invoiceId }).then((r) => r.data),
    onSuccess: (data, { id, invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["customers", data.customerId, "statement"] });
      // #2404: the order's "Applied credits" panel lists applied credits too.
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export interface UpdateCreditNoteDto {
  /** Descriptive text — editable on any non-VOID note (a VOID note is not editable: 409). */
  reason?: string;
  /** Only settable while the credit note is ISSUED (server rejects otherwise). */
  expiresAt?: string | null;
}

export function useUpdateCreditNote() {
  const qc = useQueryClient();
  return useMutation<CreditNote, Error, { id: string } & UpdateCreditNoteDto>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/credit-notes/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
    },
  });
}

export type VoidPreview = CreditNoteVoidPreview;

export function useVoidPreview(id: string, enabled: boolean) {
  return useQuery<VoidPreview>({
    queryKey: ["credit-notes", id, "void-preview"],
    queryFn: () => apiClient.get(`/credit-notes/${id}/void-preview`).then((r) => r.data),
    enabled: !!id && enabled,
    staleTime: 0,
  });
}

/**
 * SA-436 PR-2 (#2402) / #2540: void a credit note AFTER un-applying it everywhere (each pair is
 * remembered so the auto-apply sweep cannot re-apply it), with an optional reason for the audit.
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
        .post(`/credit-notes/${id}/void-with-reversal`, reason ? { reason } : {})
        .then((r) => r.data),
    onSuccess: (data, { id }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["customers", data.creditNote.customerId, "statement"] });
    },
  });
}

/** #2648 / SA-535(b): an amount/line edit (void-with-reversal + an unapplied replacement). */
export type ReissueCreditNoteDto = ReissueCreditNoteInput;
export type ReissueResult = ReissueCreditNoteResult<CreditNote>;

export function useReissueCreditNote() {
  const qc = useQueryClient();
  return useMutation<
    ReissueResult,
    Error,
    { id: string; idempotencyKey: string } & ReissueCreditNoteDto
  >({
    mutationFn: ({ id, idempotencyKey, ...dto }) =>
      apiClient
        .post(`/credit-notes/${id}/reissue`, dto, {
          headers: { "Idempotency-Key": idempotencyKey },
        })
        .then((r) => r.data),
    onSuccess: (data, { id }) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["credit-notes", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["customers", data.creditNote.customerId, "statement"] });
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open (remaining) balance on a credit note — `amount - amountUsed`, NEVER
 * `amount` alone (a partially-applied ISSUED note still carries a nonzero
 * amountUsed). Display-only client math; the server clamp is the real source
 * of truth for what actually applies.
 */
export function openCreditBalance(cn: Pick<CreditNote, "amount" | "amountUsed">): number {
  const remaining = Number(cn.amount) - Number(cn.amountUsed ?? 0);
  return Math.max(0, Math.round(remaining * 100) / 100);
}
