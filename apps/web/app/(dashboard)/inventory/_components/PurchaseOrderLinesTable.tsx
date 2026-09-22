"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { resolvePOLine, resolvePOLineAmounts } from "./purchase-orders-shared";
import { emptyEditLine, type EditLine } from "./purchase-orders-edit";

export type CatalogProduct = {
  id: string;
  name: string;
  sku?: string;
  unitsPerBox?: number | null;
};

const inputCls =
  "w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

/**
 * The line table of the edit-purchase-order form (LANE-U step 6, web half). Controlled: the modal owns
 * `lines`. On a received order a line that has arrived is locked — its product can't change, it can't
 * be removed and its quantity can't drop below what arrived (a return is the only way out); extra
 * quantity and new lines stay outstanding. Boxed products show Boxes + Pieces and a cost per box, the
 * same shape the create form uses.
 */
export function PurchaseOrderLinesTable({
  lines,
  setLines,
  products,
  received,
  fallbackName,
}: {
  lines: EditLine[];
  setLines: React.Dispatch<React.SetStateAction<EditLine[]>>;
  products: CatalogProduct[];
  /** The order is PARTIAL/RECEIVED — lines that have arrived are protected. */
  received: boolean;
  /** A line's product may be missing from the catalog list (archived) — name it from the order. */
  fallbackName: (line: EditLine) => string;
}) {
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const unitsPerBoxFor = (productId: string) =>
    Number(productById.get(productId)?.unitsPerBox ?? 0);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  const removeLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));

  const total = lines.reduce(
    (sum, l) => sum + resolvePOLineAmounts(l, unitsPerBoxFor(l.productId)).totalCost,
    0,
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-navy">Line Items</span>
        <button
          type="button"
          onClick={() => setLines((l) => [...l, emptyEditLine()])}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
        >
          <Plus className="h-3 w-3" /> Add Row
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-raised text-xs text-navy/70">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Product</th>
              <th className="w-28 px-3 py-2 text-left font-medium">Qty</th>
              <th className="w-28 px-3 py-2 text-left font-medium">Unit Cost ($)</th>
              <th className="w-24 px-3 py-2 text-right font-medium">Subtotal</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {lines.map((line, i) => {
              const upb = unitsPerBoxFor(line.productId);
              const isBoxed = upb > 1;
              const locked = received && !!line.id && line.received > 0;
              const { qty } = resolvePOLine(line, upb);
              const subtotal = resolvePOLineAmounts(line, upb).totalCost;
              return (
                <tr key={line.id ?? `new-${i}`}>
                  <td className="px-3 py-2">
                    <select
                      aria-label="Product"
                      value={line.productId}
                      disabled={locked}
                      onChange={(e) => updateLine(i, { productId: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">Select…</option>
                      {!productById.has(line.productId) && line.productId && (
                        <option value={line.productId}>{fallbackName(line)}</option>
                      )}
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.sku ? ` (${p.sku})` : ""}
                        </option>
                      ))}
                    </select>
                    {locked && (
                      <p className="mt-0.5 text-[10px] text-navy/50">
                        Received: {isBoxed ? unitsLabel(line.received, upb) : line.received}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {isBoxed ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          title="Boxes"
                          aria-label="Boxes"
                          value={line.boxes}
                          onChange={(e) => updateLine(i, { boxes: e.target.value })}
                          className={inputCls}
                        />
                        <span className="text-navy/30">+</span>
                        <input
                          type="number"
                          min={0}
                          max={upb - 1}
                          step={1}
                          title="Extra pieces"
                          aria-label="Extra pieces"
                          value={line.pieces}
                          onChange={(e) => updateLine(i, { pieces: e.target.value })}
                          className={inputCls}
                        />
                      </div>
                    ) : (
                      <input
                        type="number"
                        min={locked ? line.received : 0.001}
                        step={0.001}
                        aria-label="Quantity"
                        value={line.qty}
                        onChange={(e) => updateLine(i, { qty: e.target.value })}
                        className={inputCls}
                      />
                    )}
                    {isBoxed && (
                      <p className="mt-0.5 text-[10px] text-navy/50">
                        boxes + pcs · {qty} pcs total
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      step={0.0001}
                      title={isBoxed ? "Cost per box" : "Cost per unit"}
                      aria-label="Unit cost"
                      value={line.unitCost}
                      onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                      className={inputCls}
                    />
                    <p className="mt-0.5 text-[10px] text-navy/50">
                      {isBoxed ? "per box" : "per unit"}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right text-navy/70">
                    {subtotal > 0 ? formatMoney(subtotal) : "—"}
                  </td>
                  <td className="px-2 py-2">
                    {!locked && (
                      <button
                        type="button"
                        aria-label="Remove line"
                        onClick={() => removeLine(i)}
                        disabled={lines.length === 1}
                        className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-surface-border bg-surface-raised/50">
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right text-xs font-medium text-navy/70">
                Total
              </td>
              <td className="px-3 py-2 text-right text-sm font-semibold text-navy">
                {formatMoney(total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
