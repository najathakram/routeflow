/**
 * B846 / SA-808 — a vendor-bill un-receive (revertToDraft) never deletes a StockMovement (B562 /
 * SA-136: the ledger only ever grows). It appends one signed PURCHASE row per receipt row it undoes
 * and names that row's id in the note. Receipt rows and reversal rows are found by the two builders
 * and one parser below — interim text signature until B846-F adds the foreign keys.
 *
 * Every reader that wants "the last real purchase" (LAST_COST, the cost-history chart) skips BOTH
 * halves of a reversed pair through {@link dropBillRevertedPairs}: one rule, not one per reader.
 */

/** Note prefix on the reversing row; the id of the receipt row it reverses follows. */
export const BILL_REVERTED_NOTE = "BILL_REVERTED — reverses ";

/** The system note `VendorBillsService.receive` stamps on every PURCHASE row it writes for a bill. */
export const billReceiptNote = (billNumber: string): string =>
  `Auto-synced from vendor bill ${billNumber}`;

/**
 * The note on the reversing row. When the original period is filed the row is dated now instead
 * (SA-808 §3) and the note says which period: `… (original period September 2026 filed)`.
 */
export const billReversalNote = (originalId: string, filedPeriod?: string | null): string =>
  `${BILL_REVERTED_NOTE}${originalId}${filedPeriod ? ` (original period ${filedPeriod} filed)` : ""}`;

/** The receipt-row id a reversing row points at, or null when `notes` is not a bill-revert note. */
export function billReversalTargetId(notes: string | null | undefined): string | null {
  if (typeof notes !== "string" || !notes.startsWith(BILL_REVERTED_NOTE)) return null;
  const id = notes.slice(BILL_REVERTED_NOTE.length).split(/[\s(;]/, 1)[0];
  return id.length > 0 ? id : null;
}

/**
 * Rows minus every reversal (a PURCHASE with quantity <= 0, or a bill-revert note) and the receipt
 * rows those point at. Order-agnostic: the ids come from the rows given.
 */
export function dropBillRevertedPairs<
  T extends { id?: string; notes?: string | null; quantity?: unknown; type?: string },
>(rows: T[]): T[] {
  const reversed = new Set<string>();
  for (const r of rows) {
    const target = billReversalTargetId(r.notes);
    if (target) reversed.add(target);
  }
  return rows.filter((r) => {
    if (billReversalTargetId(r.notes) != null) return false;
    if (r.id && reversed.has(r.id)) return false;
    const isPurchase = r.type == null || r.type === "PURCHASE";
    return !(isPurchase && r.quantity != null && Number(r.quantity) <= 0);
  });
}
