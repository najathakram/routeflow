/**
 * Row 683 (SA-789 F2, SA-896): has a rebuild changed the REGULATED content of an invoice? The regulated ledger books, per
 * regulated line, its category and subcategory, its quantity (and the pack/unit that turn it into `unitBasisQty`), its net
 * and its category tax. When none of that changed, a rebuild that re-created every item only rotated the item ids, and the
 * ledger stays as it is (`resolveSaleLines` reaches the line through `orderItemId`). When any of it changed, the caller
 * resyncs the ledger (reverse and rewrite, append-only). Non-regulated lines never count.
 */
export interface RegulatedLineContent {
  orderItemId?: string | null;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
  qty: unknown;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  subtotal: unknown;
  categoryTaxAmount?: unknown;
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
};

/** One comparable string per regulated line, keyed by its order line (`""` for a line with none). */
function signature(lines: readonly RegulatedLineContent[] | null | undefined): string[] {
  // A caller's read can come back empty-handed (no rows, or a partial unit-test double): no lines, never a throw.
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => !!l.trackedCategoryId)
    .map((l) =>
      [
        l.orderItemId ?? "",
        l.trackedCategoryId,
        l.trackedSubcategoryId ?? "",
        num(l.qty),
        l.unitsPerBox ?? "",
        l.unitLabel ?? "",
        num(l.subtotal),
        num(l.categoryTaxAmount),
      ].join("|"),
    )
    .sort();
}

export function regulatedContentChanged(
  before: readonly RegulatedLineContent[] | null | undefined,
  after: readonly RegulatedLineContent[] | null | undefined,
): boolean {
  const a = signature(before);
  const b = signature(after);
  return a.length !== b.length || a.some((s, i) => s !== b[i]);
}
