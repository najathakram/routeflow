"use client";

import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge, Select } from "@routeflow/ui/web";
import { lowStockThreshold } from "@routeflow/types";
import { RecordCard, RecordCardList } from "@/components/RecordCard";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { InventoryCardMenu, type InventoryCardMenuItem } from "./InventoryCardMenu";

/** The fields of a stock row the phone card reads (the page's StockItem satisfies this). */
export interface InventoryCardItem {
  id: string;
  name: string;
  sku?: string;
  category?: string;
  unit: string;
  currentStock: number;
  reorderPoint?: number | null;
  averageCost: number | null;
  totalValue: number | null;
  unitsPerBox?: number | null;
  trackedCategoryId?: string | null;
}

export type StockState = "out" | "low" | "ok";

/**
 * The one rule for how a stock figure reads: out at zero or below, low at or below the reorder
 * point (5 when none is set), otherwise fine. The table's Current stock colour and the card's
 * status and amount tone both read it, so they always agree.
 */
export function stockState(
  item: Pick<InventoryCardItem, "currentStock" | "reorderPoint">,
): StockState {
  if (item.currentStock <= 0) return "out";
  if (item.currentStock <= lowStockThreshold(item.reorderPoint)) return "low";
  return "ok";
}

/** The table's text colour for each state. */
export const STOCK_TEXT_CLASS: Record<StockState, string> = {
  out: "text-danger",
  low: "text-warning",
  ok: "text-navy",
};

const STATE_BADGE: Record<
  StockState,
  { variant: "danger" | "warning" | "success"; label: string }
> = {
  out: { variant: "danger", label: "Out of stock" },
  low: { variant: "warning", label: "Low stock" },
  ok: { variant: "success", label: "In stock" },
};

const ACTION =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap rounded px-2 text-xs font-medium text-brand-600 transition-colors hover:underline";

/**
 * The phone stock list (below md): one card per product. Every value is the one the table cell
 * renders; the card does no math. The card opens the product page (the table's "Open product"),
 * and its last row holds at most two text actions (Adjust always; Set cost while no cost is set)
 * plus one "More actions" menu with the rest (Set cost when a cost exists, Movements, Assign to
 * variants where the table shows it), so the row never runs past the card.
 */
export function InventoryCards({
  items,
  sectionNameById,
  variantInfoById,
  onSetCost,
  onAdjust,
  onAssignToVariants,
}: {
  items: InventoryCardItem[];
  sectionNameById: Map<string, string>;
  variantInfoById: Map<string, { parentProductId: string | null; hasVariants: boolean }>;
  onSetCost: (item: InventoryCardItem) => void;
  onAdjust: (id: string) => void;
  onAssignToVariants: (item: InventoryCardItem) => void;
}) {
  return (
    <RecordCardList>
      {items.map((item) => {
        const state = stockState(item);
        const info = variantInfoById.get(item.id);
        const canSplit = !!info && !info.parentProductId && info.hasVariants;
        const noCost = item.averageCost == null;
        const menu: InventoryCardMenuItem[] = [
          ...(noCost ? [] : [{ label: "Set cost", onSelect: () => onSetCost(item) }]),
          { label: "Movements", href: `/inventory/movements?product=${item.id}` },
          ...(canSplit
            ? [{ label: "Assign to variants", onSelect: () => onAssignToVariants(item) }]
            : []),
        ];
        return (
          <RecordCard
            key={item.id}
            href={`/products/${item.id}`}
            title={item.name}
            titleKind="name"
            amountLabel="Current stock"
            amount={unitsLabel(Number(item.currentStock), item.unitsPerBox, item.unit)}
            amountTone={state === "out" ? "danger" : "default"}
            subtitle={
              <>
                <span className="font-mono text-xs text-navy/70">{item.sku ?? "—"}</span>
                {item.category ? (
                  <span className="text-xs text-navy/60"> · {item.category}</span>
                ) : null}
              </>
            }
            badges={
              <>
                <Badge variant={STATE_BADGE[state].variant}>{STATE_BADGE[state].label}</Badge>
                {item.trackedCategoryId && (
                  <span className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                    {sectionNameById.get(item.trackedCategoryId) ?? "Type"}
                  </span>
                )}
                {item.averageCost != null ? (
                  <span className="text-xs text-navy/60">
                    Unit cost {formatMoney(item.averageCost)}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                    No cost set
                  </span>
                )}
                <span className="text-xs text-navy/60">
                  Total value {item.totalValue != null ? formatMoney(item.totalValue) : "—"}
                </span>
              </>
            }
            actions={
              <>
                {noCost && (
                  <button type="button" onClick={() => onSetCost(item)} className={ACTION}>
                    Set cost
                  </button>
                )}
                <button type="button" onClick={() => onAdjust(item.id)} className={ACTION}>
                  Adjust
                </button>
                <InventoryCardMenu name={item.name} items={menu} />
              </>
            }
          />
        );
      })}
    </RecordCardList>
  );
}

const SORT_OPTIONS = [
  { value: "name", label: "Product" },
  { value: "sku", label: "SKU" },
  { value: "category", label: "Category" },
  { value: "currentStock", label: "Current stock" },
  { value: "unitsPerBox", label: "Per Box" },
  { value: "averageCost", label: "Unit cost" },
  { value: "totalValue", label: "Total value" },
];

/** The phone sort control: the table's sortable columns in a select and a direction button. */
export function InventorySortControl({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string, dir: "asc" | "desc") => void;
}) {
  return (
    <div className="flex items-center gap-1.5 md:hidden">
      <div className="min-w-0 flex-1">
        <Select
          aria-label="Sort products by"
          options={SORT_OPTIONS}
          value={sortKey ?? ""}
          onChange={(e) => {
            if (e.target.value && e.target.value !== sortKey) onSort(e.target.value, "asc");
          }}
          className="h-11"
        />
      </div>
      <button
        type="button"
        onClick={() => onSort(sortKey ?? "name", sortDir === "asc" ? "desc" : "asc")}
        aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-ctl border border-surface-border bg-white text-navy hover:bg-surface-raised"
      >
        {sortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
      </button>
    </div>
  );
}
