import { roundMoney } from "@routeflow/pricing";

/** A bill line as create/update receive it or as a stored row reads: qty and either cost field. */
export interface BillLineAmounts {
  qty?: unknown;
  unitCost?: unknown;
  unitPrice?: unknown;
}

/**
 * The ONE pre-tax total of a bill's lines: `(qty || 1) x (unitCost ?? unitPrice ?? 0)` per line,
 * summed and rounded to cents. create(), update() and the tax-only rebuild all price lines through
 * this, so the three can never disagree about a line (a missing qty is 1; a missing unitCost falls
 * back to unitPrice). A stored row has no unitPrice column, so for it the fallback never fires.
 */
export function billLinesTotal(items: readonly BillLineAmounts[]): number {
  return roundMoney(
    items.reduce(
      (sum, item) => sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
      0,
    ),
  );
}
