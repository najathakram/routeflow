import {
  assertNoUnspentSourcedCredits,
  unlinkSourcedCredits,
} from "../credit-notes/sourced-credit-guard";
import { assertNoWriteOffHistory } from "../invoices/invoice-write-off-history";

/** The slice of the transaction client this helper reads and writes (the rest rides through to unlinkSourcedCredits). */
export interface InvoiceDeleteTx {
  /** Read by `assertNoWriteOffHistory`. */
  invoiceWriteOffEvent?: unknown;
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
 * transaction. SA-1000: it runs `assertNoUnspentSourcedCredits` ITSELF as its first statement, so no door can
 * reach the delete without the refusal (a read under the caller's locks; the callers' earlier calls stay as
 * the fail-fast check before any lock or write, and `deleteOrder`'s covers every invoice in one read).
 */
export async function deleteOrderInvoice(
  tx: InvoiceDeleteTx,
  invoiceId: string,
  tenantId: string | null,
): Promise<void> {
  await assertNoUnspentSourcedCredits(tx, [invoiceId]);
  // SA-1050 A-1 (REFUSE): the same refusal for every order-side door, before any write (RESTRICT FK, bad-debt ledger).
  await assertNoWriteOffHistory(tx, [invoiceId]);
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
