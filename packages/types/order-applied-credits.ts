/**
 * #2404 (P0, epic #2400, SA-436 PR-3): one rule for the order's "Applied credits" panel, shared
 * by web and mobile. It is built from the credit ACTUALLY on the order's invoices (every non-VOID
 * CREDIT_NOTE payment on a non-VOID invoice, automatic or manual) plus the hand-picked
 * OrderCreditNote intents not yet applied to any of them. The old panel listed intents only, so
 * a credit auto-applied on send never showed on the order.
 *
 * No arithmetic: each row's amount is the server-rounded payment amount, parsed for display.
 */

export interface AppliedCreditNoteRef {
  id: string;
  creditNoteNumber: string;
  reason?: string | null;
}

export interface AppliedCreditPaymentInput {
  id: string;
  amount: string | number;
  creditNoteId?: string | null;
  /** Omitted by callers that already selected CREDIT_NOTE payments only. */
  method?: string;
  /** Omitted by callers that already excluded VOID payments. */
  status?: string;
  /** SA-436 PR-1: true when the auto-apply sweep wrote this payment (existing rows: false). */
  autoApplied: boolean;
  creditNote?: AppliedCreditNoteRef | null;
}

export interface OrderAppliedCreditsInput {
  invoices?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    payments?: AppliedCreditPaymentInput[];
  }>;
  orderCreditNotes?: Array<{
    id: string;
    creditNoteId: string;
    /** The requested cap; null = "up to what remains on the note". */
    amount?: string | number | null;
    creditNote?: AppliedCreditNoteRef | null;
  }>;
}

export type OrderAppliedCreditRow =
  | {
      kind: "applied";
      key: string;
      paymentId: string;
      creditNoteId: string;
      creditNoteNumber: string;
      reason: string | null;
      invoiceId: string;
      invoiceNumber: string;
      amount: number;
      source: "automatic" | "manual";
    }
  | {
      kind: "pending";
      key: string;
      paymentId?: undefined;
      creditNoteId: string;
      creditNoteNumber: string;
      reason: string | null;
      /** The requested cap, or null for "up to remaining". */
      requested: number | null;
    };

export function orderAppliedCredits(order: OrderAppliedCreditsInput): OrderAppliedCreditRow[] {
  const rows: OrderAppliedCreditRow[] = [];
  const applied = new Set<string>();

  for (const inv of order.invoices ?? []) {
    if (inv.status === "VOID") continue;
    for (const p of inv.payments ?? []) {
      if (!p.creditNoteId) continue;
      if (p.method !== undefined && p.method !== "CREDIT_NOTE") continue;
      if (p.status === "VOID") continue;
      applied.add(p.creditNoteId);
      rows.push({
        kind: "applied",
        key: `payment:${p.id}`,
        paymentId: p.id,
        creditNoteId: p.creditNoteId,
        creditNoteNumber: p.creditNote?.creditNoteNumber ?? p.creditNoteId.slice(0, 8),
        reason: p.creditNote?.reason ?? null,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: Number(p.amount),
        source: p.autoApplied ? "automatic" : "manual",
      });
    }
  }

  for (const oc of order.orderCreditNotes ?? []) {
    if (applied.has(oc.creditNoteId)) continue;
    rows.push({
      kind: "pending",
      key: `intent:${oc.id}`,
      creditNoteId: oc.creditNoteId,
      creditNoteNumber: oc.creditNote?.creditNoteNumber ?? oc.creditNoteId.slice(0, 8),
      reason: oc.creditNote?.reason ?? null,
      requested: oc.amount == null ? null : Number(oc.amount),
    });
  }
  return rows;
}
