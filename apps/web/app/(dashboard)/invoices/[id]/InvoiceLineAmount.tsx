import { fmt } from "@/lib/formatting";
import { storedOrComputedLineSubtotal, type StoredOrComputedLineInput } from "@/lib/line-subtotal";

/**
 * The invoice detail page's per-line "Amount" cell (a `<td>`). Extracted from `page.tsx` so the
 * money is directly RTL-testable without mounting the whole page.
 *
 * The stored line subtotal is authoritative (boxed-aware, post-discount, rounded). Only when a
 * payload omits it do we re-price — through `@routeflow/pricing`, never `qty * unitPrice`, which
 * over-charges a boxed line (qty = pieces, unitPrice = BOX price) by `unitsPerBox`.
 */
export function InvoiceLineAmount({ item }: { item: StoredOrComputedLineInput }) {
  return (
    <td className="px-8 py-3 text-right">
      <span className="money text-navy">{fmt(storedOrComputedLineSubtotal(item))}</span>
    </td>
  );
}
