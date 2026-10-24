import { effectiveQty } from "@routeflow/pricing";
import type { LineState, Product } from "./cart-line-state";
import {
  groupLinesForInvoiceSplit,
  type InvoiceSplitCategory,
  type InvoiceSplitLineInput,
  type InvoiceSplitPreview,
} from "./invoice-split";

/**
 * REG-4 live, DISPLAY-ONLY preview of how a cart splits into invoices (extracted verbatim from NewOrderScreen.tsx's
 * `invoiceSplit` memo, size-ratchet). Same iteration/inputs as the total memo, so it can never disagree with what's on
 * screen. NEVER used for money: computeLineSubtotal inside groupLinesForInvoiceSplit produces the same pre-tax per-line
 * amounts the total memo already sums; this just also buckets them by category. The server is the sole source of truth.
 */
export function buildInvoiceSplitPreview(
  items: Record<string, LineState>,
  productById: Map<string, Product>,
  unlisted: readonly { unitPrice: number; qty: number }[],
  splitCategoryById: Map<string, InvoiceSplitCategory>,
  {
    lineUnitFor,
    effectiveTierFor,
  }: {
    lineUnitFor: (line: LineState | undefined, p: Product, tier: number) => number;
    effectiveTierFor: (id: string) => number;
  },
): InvoiceSplitPreview {
  const splitLines: InvoiceSplitLineInput[] = [];
  for (const [id, line] of Object.entries(items)) {
    const p = productById.get(id);
    if (!p) continue;
    const qty = effectiveQty(line, p.unitsPerBox);
    if (qty <= 0) continue;
    splitLines.push({
      trackedCategoryId: p.trackedCategoryId ?? null,
      unitPrice: lineUnitFor(line, p, effectiveTierFor(p.id)),
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: p.unitsPerBox ?? null,
    });
  }
  for (const u of unlisted) {
    if (u.qty <= 0) continue;
    splitLines.push({ trackedCategoryId: null, unitPrice: u.unitPrice, qty: u.qty });
  }
  return groupLinesForInvoiceSplit(splitLines, splitCategoryById);
}
