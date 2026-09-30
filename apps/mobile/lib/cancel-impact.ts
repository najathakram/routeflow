/**
 * Turns the server's cancel-impact preview into the sentences an operator reads
 * before they commit. Pure so both the phrasing and the plurals are testable —
 * this is the only warning between a tap and voiding live invoices.
 *
 * Mirrored in apps/web/lib/cancel-impact.ts — keep the two in step.
 */
export interface CancelImpactLike {
  invoicesToVoid: Array<{ invoiceNumber: string; status: string; total: number }>;
  creditsToRestore: Array<{ creditNoteNumber: string; amount: number }>;
  advanceToRestore: number;
  blockingPayments: Array<{ invoiceNumber: string; amount: number }>;
  canCancel: boolean;
  /**
   * B56: units already delivered. OPTIONAL on purpose — a client build can be
   * older or newer than the API that answers it, and an absent field must read
   * as "no delivered goods" rather than crash the only warning an operator gets
   * before live invoices are voided.
   */
  deliveredUnits?: number;
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface CancelImpactCopy {
  /** Title for the confirm sheet/dialog. */
  title: string;
  /** Ordered consequence lines. Empty when cancelling has no money effect. */
  lines: string[];
  /** Set when the cancel is refused — explains what to do instead. */
  blockedReason: string | null;
  /** Label for the confirm button; null when the action is unavailable. */
  confirmLabel: string | null;
}

export function describeCancelImpact(impact: CancelImpactLike | undefined): CancelImpactCopy {
  if (!impact) {
    return {
      title: "Cancel this order?",
      lines: [],
      blockedReason: null,
      confirmLabel: "Cancel order",
    };
  }

  if (!impact.canCancel) {
    if (impact.blockingPayments.length > 0) {
      const detail = impact.blockingPayments
        .map((b) => `${money(b.amount)} on ${b.invoiceNumber || "an invoice"}`)
        .join(", ");
      return {
        title: "Can't cancel yet",
        lines: [],
        // Cash already left the customer's hands; only a human can give it back.
        blockedReason: `This order has been paid: ${detail}. Refund or reverse that payment first, then cancel.`,
        confirmLabel: null,
      };
    }
    if ((impact.deliveredUnits ?? 0) > 0.001) {
      return {
        title: "Can't cancel",
        lines: [],
        blockedReason:
          "Some items on this order have already been delivered. Record a return for the delivered goods, or edit the order down to the undelivered items instead of cancelling.",
        confirmLabel: null,
      };
    }
    return {
      title: "Can't cancel",
      lines: [],
      blockedReason: "This order can't be cancelled right now.",
      confirmLabel: null,
    };
  }

  const lines: string[] = [];
  if (impact.invoicesToVoid.length) {
    const numbers = impact.invoicesToVoid.map((i) => i.invoiceNumber || "draft").join(", ");
    lines.push(`${plural(impact.invoicesToVoid.length, "invoice")} will be voided: ${numbers}.`);
  }
  for (const c of impact.creditsToRestore) {
    lines.push(`${money(c.amount)} goes back to credit note ${c.creditNoteNumber}.`);
  }
  if (impact.advanceToRestore > 0.001) {
    lines.push(`${money(impact.advanceToRestore)} returns to the customer's advance balance.`);
  }

  return {
    title: "Cancel this order?",
    lines,
    blockedReason: null,
    confirmLabel: "Cancel order",
  };
}
