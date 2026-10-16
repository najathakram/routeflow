/**
 * B846 / SA-808 — a vendor-bill un-receive (revertToDraft) never deletes a StockMovement (B562 /
 * SA-136: the ledger only ever grows). It appends one signed PURCHASE row per receipt row it undoes
 * and names that row's id in the note. Receipt rows and reversal rows are found by the two builders
 * and one parser below — interim text signature until B846-F adds the foreign keys.
 *
 * Every reader that wants "the last real purchase" (LAST_COST, the cost-history chart) skips BOTH
 * halves of a reversed pair through {@link pairedReceiptIds}: one rule, not one per reader.
 */

/** Note prefix on the reversing row; the id of the receipt row it reverses follows. */
export const BILL_REVERTED_NOTE = "BILL_REVERTED — reverses ";

/** The system note `VendorBillsService.receive` stamps on every PURCHASE row it writes for a bill. */
export const billReceiptNote = (billNumber: string): string =>
  `Auto-synced from vendor bill ${billNumber}`;

/**
 * The note on the reversing row. When the original period is filed the row is dated now instead
 * (SA-808 §3, SA-808a) and the note names the filing: `… (filed through September 2026)`.
 */
export const billReversalNote = (originalId: string, filedThroughLabel?: string | null): string =>
  `${BILL_REVERTED_NOTE}${originalId}${filedThroughLabel ? ` (filed through ${filedThroughLabel})` : ""}`;

/** The receipt-row id a reversing row points at, or null when `notes` is not a bill-revert note. */
export function billReversalTargetId(notes: string | null | undefined): string | null {
  if (typeof notes !== "string" || !notes.startsWith(BILL_REVERTED_NOTE)) return null;
  const id = notes.slice(BILL_REVERTED_NOTE.length).split(/[\s(;]/, 1)[0];
  return id.length > 0 ? id : null;
}

/**
 * Ids of the receipt rows a bill-revert has already paired for this product. Readers that want "a
 * real purchase" (LAST_COST, the cost-history chart) exclude these ids and every non-positive row in
 * their own SQL `where`, so reversal pairs can never fill a read window.
 */
export async function pairedReceiptIds(
  db: { stockMovement: { findMany(args: any): Promise<any> } },
  productId: string,
): Promise<string[]> {
  const reversals: { notes: string | null }[] =
    (await db.stockMovement.findMany({
      where: { productId, type: "PURCHASE", notes: { startsWith: BILL_REVERTED_NOTE } },
      select: { notes: true },
    })) ?? [];
  return reversals.map((r) => billReversalTargetId(r.notes)).filter((x): x is string => x != null);
}
