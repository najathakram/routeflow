/**
 * SA-1098 Undo gap: what `RoutesService.reopenStop` does to the order's open draft(s) once the stop's delivery evidence is gone.
 *
 * Before this, Undo left the draft on the last visit's numbers (a short 7 of 10 stayed $90). If the office issued it in that gap, the
 * next completion leaves an issued invoice alone (`delivered-reconcile.ts`), so it stayed under-billed. Now the same transaction that
 * deletes the evidence rebuilds the draft(s), with the same one rebuild the completion uses (`reconcileOrderDeliveredInvoices`: the
 * unbilled live lines are put back on a draft first, a split order's drafts are rebuilt per group, and a partition it cannot read cleanly
 * is left as it was, never guessed):
 *
 *   - no delivery evidence left on the order (no `DeliveryMutation` row, no line with a delivered quantity): the ORDER basis, the
 *     pending mirror as it was before any visit;
 *   - another stop's evidence left (a re-delivery visit, D-6): the DELIVERED basis, so the draft shows what those visits delivered.
 *
 * A line that cannot be placed on a draft stays off and writes no needs-review row (nothing is delivered after an Undo; the next
 * completion flags it if it is still true).
 *
 * Only an open DRAFT follows the Undo. An invoice the office already issued is not rebuilt (the completion rule), and a deposit mirror
 * issued at placement is not touched either. The caller's transaction already holds the Order row; the rebuild takes the order's
 * invoices id-sorted after it (SA-760 R-1), the same order every billing writer uses. Orders go in id order so two Undos that share
 * orders take their locks in the same sequence.
 *
 * Accepted, as for the completion (D-42): a lone office partial (line 1 only) cannot be told from a draft a short delivery shrank, so it
 * is rebuilt too; the lines it holds come back at the order quantity.
 */
export interface UndoDraftRebuildDeps {
  findOpenOrderDraft: (orderId: string, tx?: any) => Promise<any>;
  /** `onOrder` = true rebuilds on the order basis (the default is the delivered basis). */
  reconcileOrderDeliveredInvoices: (orderId: string, tx?: any, onOrder?: boolean) => Promise<any>;
}

/**
 * @param evidence the delivery-evidence rows `reopenStop` just deleted: their orders are the ones whose draft followed this stop
 * (an order that has since moved to another stop is included)
 */
export async function rebuildDraftsAfterUndo(
  deps: UndoDraftRebuildDeps,
  tx: any,
  evidence: Array<{ orderId: string }>,
): Promise<void> {
  for (const orderId of [...new Set(evidence.map((r) => r.orderId))].sort()) {
    if (!(await deps.findOpenOrderDraft(orderId, tx))) continue; // issued invoices are left as they are
    const left =
      (await tx.deliveryMutation.count({ where: { orderId } })) +
      (await tx.orderItem.count({ where: { orderId, deliveredQty: { gt: 0 } } }));
    await deps.reconcileOrderDeliveredInvoices(orderId, tx, left === 0);
  }
}
