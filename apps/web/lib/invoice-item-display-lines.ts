import { invoiceDisplayCategoryTax, invoiceDisplayLines } from "@routeflow/pricing";
import type { InvoiceDisplayLines } from "@routeflow/pricing";
import type { InvoiceDisplayUnitView, LineComponentView } from "@routeflow/types";

/**
 * SA-1029 A-1: the ONE read of how an invoice line lays out (today / pieces / components), shared by the staff invoice and
 * the buyer portal. The Per piece column decides from `layout === "today"` of this same call, so a pieces-kind line whose
 * stored pack disagrees (the SA-827b fallback) shows the column exactly where the PDF does.
 */
type LayoutItem = Parameters<typeof invoiceDisplayCategoryTax>[0] & {
  description: string;
  qty?: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  unitPrice?: number | string;
  subtotal?: number | string;
  components?: LineComponentView[] | null;
  displayUnit?: InvoiceDisplayUnitView | null;
};

export function invoiceItemDisplayLines(item: LayoutItem): InvoiceDisplayLines {
  return invoiceDisplayLines(
    {
      description: item.description,
      qty: Number(item.qty),
      boxes: item.boxes,
      pieces: item.pieces,
      unitsPerBox: item.unitsPerBox,
      unitLabel: item.unitLabel,
      unitPrice: Number(item.unitPrice),
      subtotal: Number(item.subtotal),
      categoryTax: invoiceDisplayCategoryTax(item),
    },
    (item.components ?? []).map((c) => ({
      componentProductId: c.componentProductId,
      name: c.name,
      qty: Number(c.qty),
      unitSku: c.unitSku,
      unitBarcode: c.unitBarcode,
      displayUnitPrice4: c.displayUnitPrice4 == null ? null : Number(c.displayUnitPrice4),
      position: c.position,
    })),
    item.displayUnit,
  );
}

/** The Per piece column shows when at least one line renders in today's layout with a per-piece price. */
export function showPerPieceColumn(
  items: ReadonlyArray<LayoutItem & { perBaseUnit?: unknown }> | null | undefined,
): boolean {
  return (items ?? []).some(
    (it) => !!it.perBaseUnit && invoiceItemDisplayLines(it).layout === "today",
  );
}
