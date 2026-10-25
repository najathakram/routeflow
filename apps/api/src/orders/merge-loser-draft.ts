import { assertNoUnspentSourcedCredits } from "../credit-notes/sourced-credit-guard";
import { lockInvoiceRowsInOrder } from "../regulated/ledger-locks";
import type { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

/**
 * The order merge's loser keeps an open DRAFT mirror; before `forceConsolidateCustomer` deletes it (items, then the
 * invoice), this makes the delete safe. The caller already holds the merge group's Order rows (lockAndRecheckMergeInputs).
 *  - B214 (REG-B214): a DRAFT mirror can source a credit note; refuse before the FK SET NULL orphans it.
 *  - 683 (SA-789 F3, SA-896): a draft mirror carries SALE rows (booked at creation). Settle them to zero first, the
 *    customer-purge shape (`INVOICE_ZEROED`), after locking the Invoice row (SA-839 order: Orders, then Invoices); the
 *    merged lines are booked again on the winner's draft.
 */
export async function clearLoserDraftForDelete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant transaction client
  tx: any,
  ledger: Pick<RegulatedLedgerService, "settleRegulatedLedger">,
  draft: { id: string; tenantId: string | null },
): Promise<void> {
  await assertNoUnspentSourcedCredits(tx, [draft.id]);
  await lockInvoiceRowsInOrder(tx, draft.tenantId, [draft.id]);
  await ledger.settleRegulatedLedger(tx, { kind: "INVOICE_ZEROED", invoiceId: draft.id });
}
