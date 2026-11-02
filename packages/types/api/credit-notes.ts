import type { CreditNoteErrorCode } from "./error-codes";

/**
 * Credit-note request/response shapes shared by web and mobile (#2648). The server is
 * apps/api/src/credit-notes (credit-notes.controller.ts, credit-note-reissue.service.ts).
 */

/** GET /credit-notes/:id/void-preview: what a void-with-reversal would un-apply, and any refusal. */
export interface CreditNoteVoidPreview {
  /** Server text for logs only: the UI never renders it (#2418); it maps `refusalCode` to fixed copy. */
  refusal: string | null;
  refusalCode: CreditNoteErrorCode | null;
  restoresTotal: number;
  invoices: Array<{
    invoiceId: string;
    invoiceNumber: string;
    amount: number;
    statusBefore: string;
    statusAfter: string;
  }>;
}

/**
 * POST /credit-notes/:id/reissue (with an Idempotency-Key header): an amount/line edit. The server
 * voids the note with reversal and mints an unapplied replacement for the same customer and source
 * invoice, in one transaction. A line-linked note must restate its lines.
 */
export interface ReissueCreditNoteInput {
  amount: number;
  items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
  /** Omitted = the old reason; the server prefixes "Replaces <old number>". */
  reason?: string;
  /** Omitted = the old expiry (refused when already past); null = no expiry. */
  expiresAt?: string | null;
}

export interface ReissueCreditNoteResult<TCreditNote = unknown> {
  voided: { id: string; creditNoteNumber: string };
  creditNote: TCreditNote;
  /** What the void took off invoices: the new note is not applied anywhere. */
  unapplied: Array<{ invoiceId: string; invoiceNumber: string; amount: number }>;
}

/**
 * GET /credit-notes/summary?today=YYYY-MM-DD (B238): the credit-notes page's status counters and money tiles, computed by the
 * server over EVERY note (never a client fetch-all that a page cap silently truncates). Money is in dollars, cent-rounded.
 */
export interface CreditNoteSummary {
  counts: { total: number; issued: number; applied: number; void: number };
  /** Σ (amount − amountUsed) over the open notes: not void, balance left, not expired. */
  openCredit: number;
  openCount: number;
  /** Non-void notes created in the 30 days before the viewer's `today`. */
  issued30Value: number;
  issued30Count: number;
  /** The reason with the most credited (non-void) value, "—" when nothing is credited. */
  topReason: string;
  topReasonPct: number;
}
