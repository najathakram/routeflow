"use client";

import * as React from "react";
import type { ProductPriceGridDto, ProductPriceGridRowDto } from "@routeflow/types";
import { useTierLabels } from "@/lib/api/tier-labels";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { productTierLabel } from "@/lib/tier-one-label";
import { MoneyFigure } from "./MoneyFigure";
import { usePriceWindowOpener } from "./PriceWindowHost";

/**
 * K11-20c: a price shown as a quiet read-only figure (the Auto or Set word beside it) that opens the floating price
 * window on its own box. The figure is always the SERVED grid's cell, never a draft and never the product row's copy.
 */
export const TIERS = [1, 2, 3, 4, 5] as const;

/** The grid row for a unit level: by its id, else (the 1-piece level) the base row. */
export function rowForUnit(
  grid: ProductPriceGridDto | null | undefined,
  unit: { id: string; factorToBase: number },
): ProductPriceGridRowDto | undefined {
  return (
    grid?.rows?.find((r) => r.ref === unit.id) ??
    (unit.factorToBase === 1 ? grid?.rows?.find((r) => r.kind === "base") : undefined)
  );
}

export const packRowOf = (grid: ProductPriceGridDto | null | undefined) =>
  grid?.rows?.find((r) => r.kind === "pack");

/** One tier's figure. A button when the row can be edited; plain text when it cannot or no window is mounted. */
export function PriceFigure({
  row,
  tier,
  anchor,
  fallback,
  disabled,
  className,
}: {
  row: ProductPriceGridRowDto | undefined;
  tier: (typeof TIERS)[number];
  /** The card the window hangs off. */
  anchor: () => HTMLElement | null | undefined;
  /** Where focus goes on close if the figure is gone. */
  fallback?: () => HTMLElement | null | undefined;
  disabled?: boolean;
  className?: string;
}) {
  const opener = usePriceWindowOpener();
  const names = useTierLabels().data;
  const describedBy = React.useId();
  const cell = row?.cells.find((c) => c.tier === tier);
  if (!row || !cell) {
    return (
      <span className={className}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{productTierLabel(names, tier)} price not available</span>
      </span>
    );
  }
  const body = (
    <span id={describedBy} className="inline-flex items-baseline gap-1.5">
      <MoneyFigure value={cell.value} className="font-mono text-sm font-medium text-navy" />
      <span className="text-[10px] uppercase tracking-wide text-navy/50">
        {cell.source === "set" ? "Set" : "Auto"}
      </span>
    </span>
  );
  if (!opener || !row.editable) {
    return <span className={className}>{body}</span>;
  }
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Edit ${productTierLabel(names, tier)} ${row.label} price`}
      aria-describedby={describedBy}
      data-testid={`price-figure-${row.ref}-${tier}`}
      className={
        className ??
        "inline-flex min-h-8 items-center rounded-md px-1.5 py-0.5 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-60"
      }
      onClick={(e) =>
        opener.open({
          origin: e.currentTarget,
          anchor: anchor() ?? null,
          focus: { ref: row.ref, tier },
          fallback,
        })
      }
    >
      {body}
    </button>
  );
}

/**
 * Details "Pricing Tiers" with the v2 prices on: ONE read-only line of the five figures from the grid's pack row, each a
 * button to the window. In Details edit mode the figures are plain text and "Edit prices" is disabled (the Details save
 * carries no price, so prices are never edited in two places at once).
 */
export function DetailsPriceLine({
  productId,
  isEditing,
  anchor,
}: {
  productId: string;
  isEditing: boolean;
  anchor: () => HTMLElement | null | undefined;
}) {
  const opener = usePriceWindowOpener();
  const names = useTierLabels().data;
  const row = packRowOf(usePriceGrid(productId).data);
  const hintId = React.useId();
  const plain: ProductPriceGridRowDto | undefined =
    row && isEditing ? { ...row, editable: false } : row;
  return (
    <div data-testid="details-price-line" className="mt-5 border-t border-surface-border pt-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Pricing Tiers
        </p>
        {isEditing && opener && (
          <>
            <button
              type="button"
              disabled
              aria-describedby={hintId}
              className="rounded-md border border-surface-border px-2.5 py-1 text-xs font-medium text-navy/50"
            >
              Edit prices
            </button>
            <span id={hintId} className="sr-only">
              Save or cancel Details first
            </span>
          </>
        )}
      </div>
      <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {TIERS.map((t) => (
          <li key={t} className="flex items-baseline gap-1.5">
            <span className="text-xs text-navy/70">{productTierLabel(names, t)}</span>
            <PriceFigure row={plain} tier={t} anchor={anchor} />
          </li>
        ))}
      </ul>
    </div>
  );
}
