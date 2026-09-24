"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { linePack, resolvePOLine, resolvePOLineAmounts } from "./purchase-orders-shared";
import { emptyEditLine, type EditLine } from "./purchase-orders-edit";

export type CatalogProduct = {
  id: string;
  name: string;
  sku?: string;
  unitsPerBox?: number | null;
};

const inputCls =
  "w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";
/** A numeric input never shrinks below a readable width, whatever its cell does. */
const NUM_MIN = "min-w-[3.5rem]";
/** Stacked (< md) layout: a small visible caption above each control; md+ has a header row instead. */
const CELL_LABEL = "mb-0.5 block text-[11px] font-medium text-navy/60 md:hidden";
/** The same caption inline, for the stacked subtotal that sits beside the remove button. */
const INLINE_LABEL = "mr-1 text-[11px] font-medium text-navy/60 md:hidden";
/** md+: product | qty | cost | subtotal | remove. Below md each line is a single stacked column. */
const ROW_COLS =
  "md:grid-cols-[minmax(0,1.6fr)_minmax(9rem,1.3fr)_minmax(6rem,0.9fr)_5rem_1.5rem] md:gap-3";

/**
 * The line table of the edit-purchase-order form (LANE-U step 6, web half). Controlled: the modal owns
 * `lines`. On a received order a line that has arrived is locked — its product can't change, it can't
 * be removed and its quantity can't drop below what arrived (a return is the only way out); extra
 * quantity and new lines stay outstanding. Boxed products show Boxes + Pieces and a cost per box, the
 * same shape the create form uses.
 *
 * MONEY: every subtotal and the running total route through `resolvePOLineAmounts(...).totalCost` —
 * the ONE `@routeflow/pricing` builder — and NEVER `qty * unitCost`. A boxed line's `unitCost` is the
 * per-piece figure at 4 dp, for costing only; multiplying it back by pieces is the exact defect #1199
 * fixed (1,000 cases of $11.00 read as $11,000.40, not $11,000.00). `resolvePOLine` below is used ONLY
 * for the display piece-count ("N pcs total"), never for money.
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
    (sum, l) => sum + resolvePOLineAmounts(l, linePack(l, unitsPerBoxFor(l.productId))).totalCost,
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
      {/* One grid per line, not a <table>: a table column can't stack, so at 390 the cost and
          boxes/pieces inputs were squeezed to ~28px (blank) and at 768 clipped. Below md each line is
          a card (product, qty, cost, then subtotal + remove); from md up the same cells sit in
          columns under a header row. `min-w-0` on every cell and a floor on each input keep a
          readable width at every viewport, and nothing forces the page wider. */}
      <div role="table" aria-label="Line items" className="rounded-lg border border-surface-border">
        <div
          role="row"
          className={`${ROW_COLS} hidden bg-surface-raised px-3 py-2 text-xs text-navy/70 md:grid`}
        >
          <span role="columnheader" className="font-medium">
            Product
          </span>
          <span role="columnheader" className="font-medium">
            Qty
          </span>
          <span role="columnheader" className="font-medium">
            Unit Cost ($)
          </span>
          <span role="columnheader" className="text-right font-medium">
            Subtotal
          </span>
          <span role="columnheader" aria-label="Remove" />
        </div>
        <div role="rowgroup" className="divide-y divide-surface-border">
          {lines.map((line, i) => {
            const upb = linePack(line, unitsPerBoxFor(line.productId)); // B699: stored pack wins
            const isBoxed = upb > 1;
            const locked = received && !!line.id && line.received > 0;
            const { qty } = resolvePOLine(line, upb);
            const subtotal = resolvePOLineAmounts(line, upb).totalCost;
            return (
              <div
                role="row"
                key={line.id ?? `new-${i}`}
                className={`${ROW_COLS} grid gap-3 p-3 md:items-start`}
              >
                <div role="cell" className="min-w-0">
                  <select
                    aria-label="Product"
                    value={line.productId}
                    disabled={locked}
                    onChange={(e) => updateLine(i, { productId: e.target.value, packSize: null })}
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
                </div>
                <div role="cell" className="min-w-0">
                  <span aria-hidden="true" className={CELL_LABEL}>
                    {isBoxed ? "Boxes + pieces" : "Qty"}
                  </span>
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
                        className={`${inputCls} ${NUM_MIN}`}
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
                        className={`${inputCls} ${NUM_MIN}`}
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
                      className={`${inputCls} ${NUM_MIN}`}
                    />
                  )}
                  {isBoxed && (
                    <p className="mt-0.5 text-[10px] text-navy/50">boxes + pcs · {qty} pcs total</p>
                  )}
                </div>
                <div role="cell" className="min-w-0">
                  <span aria-hidden="true" className={CELL_LABEL}>
                    Unit cost ($)
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={0.0001}
                    title={isBoxed ? "Cost per box" : "Cost per unit"}
                    aria-label="Unit cost"
                    value={line.unitCost}
                    onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                    className={`${inputCls} ${NUM_MIN}`}
                  />
                  <p className="mt-0.5 text-[10px] text-navy/50">
                    {isBoxed ? "per box" : "per unit"}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2 md:contents">
                  <div role="cell" className="min-w-0 md:text-right md:text-navy/70">
                    <span aria-hidden="true" className={INLINE_LABEL}>
                      Subtotal
                    </span>
                    <span className="text-sm text-navy/70">
                      {subtotal > 0 ? formatMoney(subtotal) : "—"}
                    </span>
                  </div>
                  <div role="cell" className="md:text-right">
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
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-surface-border bg-surface-raised/50 px-3 py-2">
          <span className="text-xs font-medium text-navy/70">Total</span>
          <span className="text-sm font-semibold text-navy">{formatMoney(total)}</span>
        </div>
      </div>
    </div>
  );
}
