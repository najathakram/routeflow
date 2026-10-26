import { unlinkSourcedCredits } from "../credit-notes/sourced-credit-guard";

/** The slice of the transaction client this helper reads and writes (the rest rides through to unlinkSourcedCredits). */
export interface InvoiceDeleteTx {
  invoice: {
    findUnique(args: {
      where: { id: string };
      select: { invoiceNumber: true };
    }): Promise<{ invoiceNumber: string } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

/**
 * Row 259 (#2848): the ONE place the order service deletes an Invoice row - deleteOrder's invoice loop
 * and the merge-loser draft delete both call it (L-072, never re-inline). The credit notes the invoice
 * sourced are marked SOURCE_DELETED and unlinked by `unlinkSourcedCredits` (its contract, unchanged)
 * BEFORE the row goes, since the FK would otherwise null the link silently. Call it INSIDE the deleting
 * transaction, after `assertNoUnspentSourcedCredits`.
 */
export async function deleteOrderInvoice(
  tx: InvoiceDeleteTx,
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
