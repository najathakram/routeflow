/**
 * PO quick-receive form (record.tsx) pure logic. Split out so the
 * cost-prefill rule is unit-testable (R8) rather than only a source-text pin
 * on an inline closure.
 */

/**
 * The cost field's next value after picking/scanning a product (F4,
 * independent review, PR-3). A picked product prefills the field UNLESS the
 * operator already typed a cost FOR THAT SAME PRODUCT — picking a DIFFERENT
 * product always overwrites, since keeping the field only on "empty" let a
 * stale cost survive a straight scan-A-then-scan-B: B's receipt recorded at
 * A's cost, an `averageCost` write.
 */
export function nextUnitCost(currentCost: string, isNewProduct: boolean, prefill: number): string {
  if (!Number.isFinite(prefill)) return currentCost;
  if (isNewProduct || currentCost.trim() === "") {
    return String(Number(prefill.toFixed(4)));
  }
  return currentCost;
}
