import * as React from "react";
import { useLineStockViews } from "@/lib/api/stock-availability";
import { stockPiecesOf, type StockLine } from "@/lib/line-stock";

/**
 * SA-1086: the order edit builder's live stock note. The structural slice of the page's `EditItemState`
 * the note reads (kept structural so this file does not import the 1,500-line builder).
 *
 * Edit counts only the INCREASE over the saved lines, per product (what `settleStockForEdit` compares):
 * a saved line's pieces are released when it is cancelled or its product is substituted, so every saved
 * line counts under its ORIGINAL product, and only the live lines count under the product they sit on now.
 */
export interface EditStockItem {
  id: string;
  isNew?: boolean;
  isUnlisted?: boolean;
  cancelled: boolean;
  /** SA-388: a locked unit line has no derivable count; it is left out. */
  countLocked?: boolean;
  productId: string;
  originalProductId: string;
  qty: number;
  originalQty: number;
  unitsPerBox?: number | null;
  originalUnitsPerBox?: number | null;
  boxSplit?: boolean;
  originalBoxSplit?: boolean;
  unitLabel?: string;
  originalUnitLabel?: string;
  unit?: string;
}

const eligible = (it: EditStockItem) => !it.isUnlisted && !it.countLocked;

/** A live edit line as the save will read it: a box-split line already holds pieces; a plain one holds its own unit. */
export function stockLineOfEditItem(it: EditStockItem): StockLine {
  return {
    key: it.id,
    productId: it.productId,
    qty: it.qty,
    boxes: it.boxSplit ? 0 : null,
    pieces: it.boxSplit ? 0 : null,
    unitsPerBox: it.unitsPerBox,
    unitLabel: it.unitLabel,
    // A stored unit line keeps its unit's factor in `unitsPerBox` (its `qty` is the count).
    unitFactor: it.unitLabel ? it.unitsPerBox : undefined,
    unit: it.unit,
  };
}

/** The pieces each product already holds on the saved order (a line that was added here holds none). */
export function savedPiecesByProduct(items: EditStockItem[]): Map<string, number> {
  const saved = new Map<string, number>();
  for (const it of items) {
    if (it.isNew || !eligible(it) || !it.originalProductId) continue;
    const pieces = stockPiecesOf({
      qty: it.originalQty,
      boxes: it.originalBoxSplit ? 0 : null,
      pieces: it.originalBoxSplit ? 0 : null,
      unitsPerBox: it.originalUnitsPerBox ?? it.unitsPerBox,
      unitLabel: it.originalUnitLabel,
      unitFactor: it.originalUnitLabel ? (it.originalUnitsPerBox ?? it.unitsPerBox) : undefined,
    });
    saved.set(
      it.originalProductId,
      Math.round(((saved.get(it.originalProductId) ?? 0) + pieces) * 1000) / 1000,
    );
  }
  return saved;
}

/**
 * One read for every live line of the edit builder, keyed by the line's id. A DRAFT holds no stock
 * (`settleStockForEdit` returns early for it) and publishing takes the whole order, so on a draft every line
 * counts whole and nothing is subtracted as "already taken".
 */
export function useEditLineStock(items: EditStockItem[], orderStatus?: string) {
  const lines = React.useMemo(
    () => items.filter((it) => !it.cancelled && eligible(it)).map(stockLineOfEditItem),
    [items],
  );
  const holdsStock = orderStatus !== "DRAFT";
  const saved = React.useMemo(
    () => (holdsStock ? savedPiecesByProduct(items) : undefined),
    [items, holdsStock],
  );
  return useLineStockViews({ lines, mode: "edit", savedPiecesByProduct: saved });
}
