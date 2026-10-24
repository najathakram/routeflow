/**
 * #2404 (epic #2400): `InvoicePayment` carries only `creditNoteId` (no Prisma relation), so an
 * order read did not say WHICH credit a payment was. This attaches each credit payment's
 * credit-note number + reason with ONE batched, tenant-scoped read, so the order's "Applied
 * credits" panel can list every credit actually applied — including one the send auto-applied
 * with no intent on the order — not just the hand-picked intents. Kept out of orders.service.ts
 * (size ratchet).
 */

/** The order read's credit-payment select; createdAt dates the legacy Automatic fallback (SA-551a). */
export const ORDER_CREDIT_PAYMENT_SELECT = {
  id: true,
  amount: true,
  creditNoteId: true,
  autoApplied: true,
  createdAt: true,
} as const;

/**
 * The order read's invoice select (moved out of orders.service.ts for the size ratchet). Row 329a: `items.taxRate` is each
 * invoice line's stored tax rate (and nothing else of the line), the web edit panel's only source for naming a tax rate.
 */
export const ORDER_INVOICES_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  total: true,
  deliveryBatchId: true, // the invoice stage (pdfVariant) keys on it
  items: { select: { taxRate: true } },
  // Applied credit-note payments, so clients can show per-credit dollars
  // actually applied without a second roundtrip.
  // Classification pending: whether this credit-note-application read
  // should count DRAFT rows is decided by campaign batch F03's
  // confirmed-payment sweep (sums go PAID-only, listings keep not-VOID
  // with visible status). F03 converts this site or writes the reasoned
  // exemption here.
  // scan-ok: draft-payment-not-void — pending F03 classification, see above.
  payments: {
    where: { method: "CREDIT_NOTE", status: { not: "VOID" } },
    // #2404: autoApplied (SA-436 PR-1) labels each credit Automatic / Manual.
    select: ORDER_CREDIT_PAYMENT_SELECT,
  },
} as const;

interface CreditNoteReader {
  creditNote: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; creditNoteNumber: true; reason: true; autoApplied: true };
    }): Promise<
      Array<{ id: string; creditNoteNumber: string; reason: string | null; autoApplied: boolean }>
    >;
  };
}

interface OrderWithCreditPayments {
  invoices?: Array<{ payments?: Array<{ creditNoteId: string | null }> }>;
}

export async function attachPaymentCreditNotes(
  db: CreditNoteReader,
  order: OrderWithCreditPayments,
): Promise<void> {
  const ids = [
    ...new Set(
      (order.invoices ?? []).flatMap((inv) =>
        (inv.payments ?? []).map((p) => p.creditNoteId).filter((id): id is string => !!id),
      ),
    ),
  ];
  if (ids.length === 0) return;
  const notes = await db.creditNote.findMany({
    where: { id: { in: ids } },
    // autoApplied (note-level): recognises a pre-#2423 sweep's payment (SA-436 review).
    select: { id: true, creditNoteNumber: true, reason: true, autoApplied: true },
  });
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const inv of order.invoices ?? []) {
    for (const p of inv.payments ?? []) {
      (p as { creditNote?: unknown }).creditNote = p.creditNoteId
        ? (byId.get(p.creditNoteId) ?? null)
        : null;
    }
  }
}
