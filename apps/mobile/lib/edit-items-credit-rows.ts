import type { CreditNote } from "./api/credit-notes";
import { toNumber } from "./cart-line-state";

export interface EditItemsCreditRow {
  id: string;
  creditNoteNumber: string;
  reason?: string;
  amount: number;
  amountUsed?: number;
  expiresAt?: string | null;
}

/**
 * Rows to show in the order editor's credit list (extracted verbatim from edit-items.tsx, size-ratchet): the customer's open
 * credits, PLUS any credit already applied to this order even if it's no longer ISSUED (e.g. fully consumed) — otherwise a
 * previously-applied credit would vanish from the list instead of showing checked — PLUS any credit just created this session.
 */
export function buildCreditRows(
  openCredits: { data?: CreditNote[] } | undefined,
  order: unknown,
  justCreatedCredits: CreditNote[],
): EditItemsCreditRow[] {
  const rows = new Map<string, EditItemsCreditRow>();
  for (const cn of openCredits?.data ?? []) {
    rows.set(cn.id, {
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      reason: cn.reason,
      amount: cn.amount,
      amountUsed: cn.amountUsed,
      expiresAt: cn.expiresAt,
    });
  }
  for (const oc of (order as any)?.orderCreditNotes ?? []) {
    if (!rows.has(oc.creditNoteId) && oc.creditNote) {
      rows.set(oc.creditNoteId, {
        id: oc.creditNoteId,
        creditNoteNumber: oc.creditNote.creditNoteNumber,
        reason: oc.creditNote.reason ?? undefined,
        amount: toNumber(oc.creditNote.amount),
        amountUsed:
          oc.creditNote.amountUsed != null ? toNumber(oc.creditNote.amountUsed) : undefined,
        expiresAt: oc.creditNote.expiresAt ?? null,
      });
    }
  }
  for (const cn of justCreatedCredits) {
    if (!rows.has(cn.id)) {
      rows.set(cn.id, {
        id: cn.id,
        creditNoteNumber: cn.creditNoteNumber,
        reason: cn.reason,
        amount: cn.amount,
        amountUsed: cn.amountUsed,
        expiresAt: cn.expiresAt,
      });
    }
  }
  return Array.from(rows.values());
}
