/**
 * #2404 (epic #2400): `InvoicePayment` carries only `creditNoteId` (no Prisma relation), so an
 * order read did not say WHICH credit a payment was. This attaches each credit payment's
 * credit-note number + reason with ONE batched, tenant-scoped read, so the order's "Applied
 * credits" panel can list every credit actually applied — including one the send auto-applied
 * with no intent on the order — not just the hand-picked intents. Kept out of orders.service.ts
 * (size ratchet).
 */

interface CreditNoteReader {
  creditNote: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; creditNoteNumber: true; reason: true };
    }): Promise<Array<{ id: string; creditNoteNumber: string; reason: string | null }>>;
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
    select: { id: true, creditNoteNumber: true, reason: true },
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
