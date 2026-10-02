"use client";

import * as React from "react";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { resolveStoredPOLineAmounts, type POItem, linePack } from "./purchase-orders-shared";

/** The read-only lines table of a purchase order (supplier units, stored-exact subtotals). Shared by
 *  the list's expanded row and the PO detail page so the two can never disagree. */
export function PurchaseOrderReadOnlyLines({
  items,
  catalogById,
}: {
  items: POItem[];
  catalogById: Map<string, { id: string; name?: string; unitsPerBox?: number | null }>;
}) {
  return (
    <div className="rounded-lg border border-surface-border overflow-x-auto bg-white">
      <table className="w-full text-xs">
        <thead className="bg-surface-raised text-navy/70">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Product</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
            <th className="px-3 py-2 text-right font-medium">Received</th>
            <th className="px-3 py-2 text-right font-medium">Subtotal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {items.map((item: POItem) => {
            const upb = linePack(item, Number(catalogById.get(item.productId)?.unitsPerBox ?? 0));
            const isBoxed = upb > 1;
            const ordered = Number(item.qtyOrdered ?? 0);
            const received = Number(item.qtyReceived ?? 0);
            // MONEY: the stored exact total through the shared resolver — never `qtyOrdered x unitCost`,
            // which re-multiplies a boxed line's rounded per-piece cost (#1199: $11,000.40 for $11,000.00).
            const subtotal = resolveStoredPOLineAmounts(item, upb).totalCost;
            return (
              <tr key={item.id}>
                <td className="px-3 py-2 font-medium text-navy">
                  {item.product?.name ?? catalogById.get(item.productId)?.name ?? "—"}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">
                  {isBoxed ? unitsLabel(ordered, upb) : ordered}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">
                  ${Number(item.unitCost).toFixed(isBoxed ? 4 : 2)}
                  {isBoxed && <span className="text-navy/30"> /pc</span>}
                </td>
                <td className="px-3 py-2 text-right text-navy/70">
                  {item.qtyReceived != null ? (
                    isBoxed ? (
                      unitsLabel(received, upb)
                    ) : (
                      received
                    )
                  ) : (
                    <span className="text-navy/30">—</span>
                  )}
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
