"use client";

import * as React from "react";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import {
  resolveStoredPOLineAmounts,
  type POItem,
  linePack,
  onHandLabel,
  poLineName,
} from "./purchase-orders-shared";
import { unitWords } from "@routeflow/pricing";

// U-3a: a PO line carries no per-product label yet, so this prints the default words.
const UW = unitWords();

/** The read-only lines table of a purchase order (supplier units, stored-exact subtotals). Shared by
 *  the list's expanded row and the PO detail page so the two can never disagree. */
export function PurchaseOrderReadOnlyLines({
  items,
  catalogById,
  status,
}: {
  items: POItem[];
  /** On PARTIAL each line also says what is still to come. */
  status?: string;
  catalogById: Map<
    string,
    {
      id: string;
      name?: string;
      unitsPerBox?: number | null;
      currentStock?: number | string | null;
    }
  >;
}) {
  const showToCome = status === "PARTIAL";
  return (
    <div className="rounded-lg border border-surface-border overflow-x-auto bg-white">
      <table className="w-full text-xs">
        <thead className="bg-surface-raised text-navy/70">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Product</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 text-right font-medium">Received</th>
            {showToCome && <th className="px-3 py-2 text-right font-medium">Still to come</th>}
            <th className="px-3 py-2 text-right font-medium">On hand</th>
            <th className="px-3 py-2 text-right font-medium">Subtotal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {items.map((item: POItem) => {
            const upb = linePack(item, Number(catalogById.get(item.productId)?.unitsPerBox ?? 0));
            const isBoxed = upb > 1;
            const ordered = Number(item.qtyOrdered ?? 0);
            const received = Number(item.qtyReceived ?? 0);
            // On hand is today's stock, split by the product's CURRENT pack (catalog, else the include), not the line's stored pack.
            const cat = catalogById.get(item.productId);
            const livePack = Number(cat?.unitsPerBox ?? item.product?.unitsPerBox ?? 0);
            const onHandText = onHandLabel(
              cat?.currentStock ?? item.product?.currentStock,
              livePack,
            );
            // MONEY: the stored exact total through the shared resolver — never `qtyOrdered x unitCost`,
            // which re-multiplies a boxed line's rounded per-piece cost (#1199: $11,000.40 for $11,000.00).
            const subtotal = resolveStoredPOLineAmounts(item, upb).totalCost;
            // Every quantity carries its unit: boxed lines print pieces plus the box split, an unboxed
            // line keeps its own noun ("48 can"), never a bare number.
            const unitNoun = item.unitLabel?.trim() || item.product?.unit;
            const qtyText = (n: number) =>
              isBoxed ? unitsLabel(n, upb) : unitsLabel(n, null, unitNoun);
            const toCome = Math.max(0, ordered - received);
            return (
              <tr key={item.id}>
                <td className="px-3 py-2 font-medium text-navy">
                  {poLineName(item, catalogById.get(item.productId)?.name)}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">{qtyText(ordered)}</td>
                <td className="px-3 py-2 text-right text-navy/70">
                  ${Number(item.unitCost).toFixed(isBoxed ? 4 : 2)}
                  {isBoxed && <span className="text-navy/30"> /{UW.base.short.one}</span>}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">
                  {item.qtyReceived != null ? (
                    qtyText(received)
                  ) : (
                    <span className="text-navy/30">—</span>
                  )}
                </td>
                {showToCome && (
                  <td data-testid="po-line-to-come" className="px-3 py-2 text-right text-navy/70">
                    {toCome > 0 ? qtyText(toCome) : <span className="text-navy/30">—</span>}
                  </td>
                )}
                <td data-testid="po-line-on-hand" className="px-3 py-2 text-right text-navy/70">
                  {onHandText}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">{formatMoney(subtotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
