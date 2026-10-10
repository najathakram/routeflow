/**
 * #2404 (P0, epic #2400, SA-436 PR-3): one rule for the order's "Applied credits" panel, shared
 * by web and mobile. It is built from the credit ACTUALLY on the order's invoices (every non-VOID
 * CREDIT_NOTE payment on a non-VOID invoice, automatic or manual) plus the hand-picked
 * OrderCreditNote intents not yet applied to any of them. The old panel listed intents only, so
 * a credit auto-applied on send never showed on the order.
 *
 * Label (SA-436 review, the owner's incident): "automatic" when the payment says so, OR when it
 * predates the flag (AUTO_APPLIED_FLAG_SINCE, SA-551a) and its note was auto-applied (note-level flag) and the order has no intent for it — payments the
 * pre-#2423 sweep wrote carry autoApplied=false, and calling those "manual" would mislabel the
 * incident's credits. Everything else is a neutral "applied"; there is no "manual" label.
 *
 * Amounts are the server-rounded payment amounts, parsed for display; `pairTotal` (the Remove
 * confirm's figure — the server's unapply reverses every payment of that note on that invoice)
 * is summed in integer cents, display only.
 */

/**
 * SA-551a: the note-level "Automatic" fallback below may fire only for payments created BEFORE the
 * per-payment flag existed. CreditNote.autoApplied stays true through later MANUAL applications
 * (which write autoApplied=false, no intent), so an unbounded fallback mislabels them. Cutoff =
 * commit 471a7670b (#2401/#2494 squash), which landed the flag-writing sweep and the migration
 * folder below together at 2026-09-27T12:13:37-05:00.
 */
export const AUTO_APPLIED_FLAG_SINCE = "2026-09-27T17:13:37.000Z";
/** Documentation only: the migration that added InvoicePayment.autoApplied. */
export const AUTO_APPLIED_FLAG_MIGRATION = "20260927043000_sa436_credit_auto_apply_off";

export interface AppliedCreditNoteRef {
  id: string;
  creditNoteNumber: string;
  reason?: string | null;
  /** The note's own total (server figure); only compared against an intent, never subtracted. */
  amount?: string | number | null;
  /** Note-level flag the auto-apply sweep has always set (pre-SA-436 sweeps never marked the
   *  payment). Used only to recognise an old sweep's payment; see `sourceOf`. */
  autoApplied?: boolean;
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
  /** When the payment was written; an undated payment never takes the legacy fallback. */
  createdAt?: string | Date | null;
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
      /** Σ this note's payments on this invoice — what Remove (unapply) gives back. */
      pairTotal: number;
      source: "automatic" | "applied";
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
      /** The credit note's own total, or null when the server did not send it. */
      creditNoteTotal: number | null;
    };

const cents = (v: string | number) => Math.round(Number(v) * 100);

export function orderAppliedCredits(order: OrderAppliedCreditsInput): OrderAppliedCreditRow[] {
  const rows: OrderAppliedCreditRow[] = [];
  const applied = new Set<string>();
  const intents = new Set((order.orderCreditNotes ?? []).map((oc) => oc.creditNoteId));
  const pairCents = new Map<string, number>();
  const counted = (inv: { status: string }, p: AppliedCreditPaymentInput) =>
    inv.status !== "VOID" &&
    !!p.creditNoteId &&
    (p.method === undefined || p.method === "CREDIT_NOTE") &&
    p.status !== "VOID";
  for (const inv of order.invoices ?? []) {
    for (const p of inv.payments ?? []) {
      if (!counted(inv, p)) continue;
      const k = `${p.creditNoteId}|${inv.id}`;
      pairCents.set(k, (pairCents.get(k) ?? 0) + cents(p.amount));
    }
  }

  for (const inv of order.invoices ?? []) {
    for (const p of inv.payments ?? []) {
      if (!counted(inv, p) || !p.creditNoteId) continue;
      applied.add(p.creditNoteId);
      const at = p.createdAt == null ? NaN : new Date(p.createdAt).getTime();
      const oldSweep =
        !!p.creditNote?.autoApplied &&
        !intents.has(p.creditNoteId) &&
        at < Date.parse(AUTO_APPLIED_FLAG_SINCE);
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
        pairTotal: (pairCents.get(`${p.creditNoteId}|${inv.id}`) ?? 0) / 100,
        source: p.autoApplied || oldSweep ? "automatic" : "applied",
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
      creditNoteTotal: oc.creditNote?.amount == null ? null : Number(oc.creditNote.amount),
    });
  }
  return rows;
}

/**
 * #2600: the pending row's intent label, shared by web and mobile so the wording cannot drift.
 * Built from the two SERVER figures only, with a comparison, never a subtraction: an intent below
 * the note's total says what happens to the rest; equal, or a total that is absent, is today's
 * "Requested $X"; no intent is "Up to remaining". `fmt` is the caller's money formatter.
 */
export function requestedLabel(
  row: Extract<OrderAppliedCreditRow, { kind: "pending" }>,
  fmt: (n: number) => string,
): string {
  if (row.requested == null) return "Up to remaining";
  if (row.creditNoteTotal != null && row.requested < row.creditNoteTotal) {
    return `Requested ${fmt(row.requested)} of ${fmt(row.creditNoteTotal)} (the rest stays as store credit)`;
  }
  return `Requested ${fmt(row.requested)}`;
}
