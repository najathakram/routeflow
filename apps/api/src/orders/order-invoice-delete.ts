import { unlinkSourcedCredits } from "../credit-notes/sourced-credit-guard";

/**
 * Row 259 (#2848): the ONE place the order service deletes an Invoice row - deleteOrder's invoice loop
 * and the merge-loser draft delete both call it (L-072, never re-inline). The credit notes the invoice
 * sourced are marked SOURCE_DELETED and unlinked by `unlinkSourcedCredits` (its contract, unchanged)
 * BEFORE the row goes, since the FK would otherwise null the link silently. Call it INSIDE the deleting
 * transaction, after `assertNoUnspentSourcedCredits`.
 */
export async function deleteOrderInvoice(
  tx: any,
  invoiceId: string,
  tenantId: string | null,
): Promise<void> {
  const row = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { invoiceNumber: true },
  });
  await unlinkSourcedCredits(
    tx,
    [{ id: invoiceId, invoiceNumber: row?.invoiceNumber ?? "" }],
    tenantId,
  );
  await tx.invoice.delete({ where: { id: invoiceId } });
}
