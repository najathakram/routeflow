import * as React from "react";
import { useLineStockViews } from "@/lib/api/stock-availability";
import type { StockLine } from "@/lib/line-stock";
import { toSaleItem } from "./counter-sale-line-edit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * SA-1086 PR-2 (CQ-13): the counter's lines as the sale will read them. Quantities come from `toSaleItem`, the very item
 * the till posts, so the note counts what the save counts (a boxed line always splits into boxes and pieces, a plain
 * line is its qty). The counter has no named selling units, so no `unitLabel`.
 */
export function stockLineOfSaleLine(l: SaleLine): StockLine {
  const sent = toSaleItem(l);
  const boxed = sent.boxes != null && sent.pieces != null;
  return {
    key: l.tempId,
    productId: l.productId,
    qty: sent.qty ?? l.qty,
    boxes: boxed ? sent.boxes : null,
    pieces: boxed ? sent.pieces : null,
    unitsPerBox: l.unitsPerBox,
    // The row words a boxed line by its pack label alone (Box / pcs by default), never the product's `unit`: the note must
    // use the same words as the stepper beside it. A plain line prints its own unit (row 298), and so does its note.
    unit: boxed ? undefined : l.unit,
    packLabel: l.packLabel,
    baseLabel: l.baseLabel,
  };
}

/**
 * The live stock note for every line of the counter: one read for the whole cart, keyed by the line's `tempId`.
 * A counter sale is created by the same path as a staff order, so the read is the `entry` one (its oversell verdict
 * and its customer rules). A note only: it never gates the sale.
 */
export function useCounterLineStock(lines: SaleLine[], customerId?: string | null) {
  const stockLines = React.useMemo(() => lines.map(stockLineOfSaleLine), [lines]);
  return useLineStockViews({ lines: stockLines, mode: "entry", customerId });
}
