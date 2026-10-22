/**
 * B846 / SA-808 — a vendor-bill un-receive (revertToDraft) never deletes a StockMovement (B562 /
 * SA-136: the ledger only ever grows). It appends one signed PURCHASE row per receipt row it undoes
 * and names that row's id in the note. Receipt rows and reversal rows are found by the two builders
 * and one parser below — interim text signature until B846-F adds the foreign keys.
 *
 * Every reader that wants "the last real purchase" (LAST_COST, the cost-history chart) skips BOTH
 * halves of a reversed pair through {@link pairedReceiptIds}: one rule, not one per reader. The PO-edit
 * sibling (SA-808 §5) writes its reversal through the same shape and joins that one rule.
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

/** The id that follows `prefix` in `notes` (up to a space, `(` or `;`), or null. One parser. */
function idAfter(prefix: string, notes: string | null | undefined): string | null {
  if (typeof notes !== "string" || !notes.startsWith(prefix)) return null;
  const id = notes.slice(prefix.length).split(/[\s(;]/, 1)[0];
  return id.length > 0 ? id : null;
}

/** The receipt-row id a reversing row points at, or null when `notes` is not a bill-revert note. */
export const billReversalTargetId = (notes: string | null | undefined): string | null =>
  idAfter(BILL_REVERTED_NOTE, notes);

/**
 * SA-808 §5 sibling (PO edit): note prefix on the row a purchase-order re-apply writes for each
 * receipt it reverses — the id of that receipt follows. Rows written before this fix are
 * type ADJUSTMENT, rows written since are type PURCHASE (negative, so the tobacco filing nets);
 * BOTH pair the same way, through {@link poReversalOf}.
 */
export const PO_REVERSAL_NOTE = "PO edit reversal — reverses ";

/** Note prefix on the ADJUSTMENT a bill VOID writes for stock that had no receipt record (SA-808b). */
export const BILL_VOID_SHORTFALL_NOTE = "Void of vendor bill ";

/** The note on a PO re-apply's reversing row; names the filing when the row moved forward to now. */
export const poReversalNote = (originalId: string, filedThroughLabel?: string | null): string =>
  `${PO_REVERSAL_NOTE}${originalId}${filedThroughLabel ? ` (filed through ${filedThroughLabel})` : ""}`;

/**
 * The receipt id a PO-edit reversing row undoes, or null when `row` is not one. A reversal is
 * NEGATIVE and type PURCHASE (current) or ADJUSTMENT (legacy): a positive row, or any other type,
 * that merely carries the text — a person's manual purchase note — never pairs a receipt.
 */
export function poReversalOf(row: {
  type: string;
  quantity: unknown;
  notes: string | null | undefined;
}): string | null {
  if (row.type !== "PURCHASE" && row.type !== "ADJUSTMENT") return null;
  if (!(Number(row.quantity) < 0)) return null;
  return idAfter(PO_REVERSAL_NOTE, row.notes);
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
  const reversals: { type: string; quantity: unknown; notes: string | null }[] =
    (await db.stockMovement.findMany({
      where: {
        productId,
        type: { in: ["PURCHASE", "ADJUSTMENT"] },
        quantity: { lt: 0 },
        OR: [
          { notes: { startsWith: BILL_REVERTED_NOTE } },
          { notes: { startsWith: PO_REVERSAL_NOTE } },
        ],
      },
      select: { type: true, quantity: true, notes: true },
    })) ?? [];
  // A bill revert is always PURCHASE; a PO reversal is PURCHASE, or ADJUSTMENT before SA-808 §5.
  return reversals
    .map((r) => (r.type === "ADJUSTMENT" ? null : billReversalTargetId(r.notes)) ?? poReversalOf(r))
    .filter((x): x is string => x != null);
}
