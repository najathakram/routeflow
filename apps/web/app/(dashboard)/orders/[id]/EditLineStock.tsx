"use client";

import * as React from "react";
import { LineStockNote } from "@/components/LineItemRow";
import { stockViewForLine, useStockAvailability } from "@/lib/api/stock-availability";

/** The edit-line fields the stock note reads (a structural slice of the page's `EditItemState`). */
export interface EditStockItem {
  productId: string;
  isUnlisted?: boolean;
  cancelled?: boolean;
  isNew?: boolean;
  originalProductId?: string | null;
  unit?: string;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  qty: number;
  originalQty: number;
  originalUnitsPerBox?: number | null;
  originalBoxSplit?: boolean;
}

/** One live-stock read for every live line of the edit builder (edit mode: the server counts only the
 *  INCREASE over the saved line). */
export function useEditLineStock(items: EditStockItem[]) {
  return useStockAvailability({
    productIds: items.filter((it) => !it.cancelled && !it.isUnlisted).map((it) => it.productId),
    mode: "edit",
  });
}

/** Stock note for one edit-mode line. `qty` is pieces for a split/plain line, selling units (cases) otherwise. */
export function EditLineStock({
  item,
  query,
}: {
  item: EditStockItem;
  query: ReturnType<typeof useStockAvailability>;
}) {
  const piecesOf = (qty: number, upb: number | null | undefined, split: boolean | undefined) =>
    Number(upb ?? 0) > 1 && !split ? qty * Number(upb) : qty;
  const sameLine = !item.isNew && item.productId === item.originalProductId;
  const view = stockViewForLine(
    query,
    {
      productId: item.productId,
      isUnlisted: item.isUnlisted,
      unit: item.unit,
      unitsPerBox: item.unitsPerBox,
      qty: piecesOf(item.qty, item.unitsPerBox, item.boxSplit),
    },
    sameLine
      ? piecesOf(
          item.originalQty,
          item.originalUnitsPerBox ?? item.unitsPerBox,
          item.originalBoxSplit,
        )
      : 0,
  );
  return view ? <LineStockNote stock={view} /> : null;
}
