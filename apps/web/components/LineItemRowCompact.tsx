"use client";

import * as React from "react";
import { StickyNote, X } from "lucide-react";
import { Fold, cn } from "@routeflow/ui/web";
import { computeLineSubtotal } from "@routeflow/pricing";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput } from "@/components/MoneyInput";
import {
  LinePriceDisplay,
  LineQtyControls,
  PendingUnitStatus,
  type LineItemRowProps,
} from "@/components/LineItemRow";

/**
 * The compact line row (redesign PR1): name, meta (price + tags), qty stepper and amount stay visible;
 * the unit picker, price field and cost/margin live in a Fold; the note keeps its own toggle. Same props and callbacks as
 * `LineItemRow` — it changes layout only. Every quantity control stays locked while a pending unit
 * loads (#2865), the amount is `computeLineSubtotal`, and the note text survives a collapse.
 */
export function LineItemRowCompact({
  item: li,
  category,
  marginFloor,
  floorAcked,
  costRevealed,
  priceHistoryEntry,
  highlighted,
  onQtyDelta,
  onSetBoxes,
  onSetPieces,
  onSetUnitQty,
  onSetSellBy,
  onSetDiscountedPrice,
  onSetToFloor,
  onAckFloor,
  onToggleCostRevealed,
  onToggleNoteOpen,
  onSetNote,
  onUpdateUnlistedName,
  onUpdateUnlistedPrice,
  onRemove,
  unitSlot,
  pendingUnit,
  onTapPrice,
  onSetQty,
  rowRef,
}: LineItemRowProps) {
  const qtyLocked = !!pendingUnit;
  const hasNote = !!li.note?.trim();
  const amount = computeLineSubtotal({
    unitPrice: li.unitPrice,
    qty: li.qty,
    boxes: li.boxes ?? null,
    pieces: li.pieces ?? null,
    unitsPerBox: li.unitsPerBox ?? null,
  });
  const showLast =
    !li.isUnlisted && priceHistoryEntry && priceHistoryEntry.lastPrice !== li.listPrice;
  const inlinePrice = !li.isUnlisted && li.priceType !== "SPECIAL" && !onTapPrice;
  return (
    <li
      ref={rowRef}
      data-testid="line-item-compact"
      className={cn(
        "px-3 py-2.5",
        category ? "border-l-2 border-l-amber-300 bg-amber-50/30" : "",
        highlighted ? "ring-2 ring-brand-500" : "",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {li.isUnlisted ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={li.productName}
                  onChange={(e) => onUpdateUnlistedName(e.target.value)}
                  placeholder="Item name"
                  className="min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-sm font-medium text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                  Custom
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-navy/70">Price:</span>
                <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
                  <span className="text-xs text-navy/40">$</span>
                  <MoneyInput
                    value={li.unitPrice}
                    onChange={(v) => onUpdateUnlistedPrice(v)}
                    className="w-16 rounded-none border-0 bg-transparent px-0 py-0.5 text-right text-xs focus:ring-0"
                  />
                </span>
                <span className="text-[10px] text-navy/70">/ {li.unit}</span>
              </div>
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-medium text-navy">{li.productName}</p>
              <LinePriceDisplay item={li} qtyLocked={qtyLocked} onTapPrice={onTapPrice} />
              {showLast && (
                <span className="text-[10px] text-navy/50">
                  Last: ${priceHistoryEntry.lastPrice.toFixed(2)}
                </span>
              )}
              {category && (
                <span className="ml-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                  {category.name} · regulated
                </span>
              )}
            </>
          )}
        </div>
        <span
          data-testid="line-total"
          className="shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums text-navy"
        >
          ${amount.toFixed(2)}
        </span>
      </div>

      <div className="mt-1.5 flex items-start justify-between gap-2">
        <LineQtyControls
          item={li}
          qtyLocked={qtyLocked}
          placement=""
          onQtyDelta={onQtyDelta}
          onSetBoxes={onSetBoxes}
          onSetPieces={onSetPieces}
          onSetUnitQty={onSetUnitQty}
          onSetSellBy={onSetSellBy}
          onSetQty={onSetQty}
        />
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onToggleNoteOpen}
            aria-pressed={!!(li.noteOpen || hasNote)}
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              hasNote ? "text-brand-500" : "text-navy/40 hover:text-navy",
            )}
            title="Add flavor / note"
          >
            <StickyNote className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-11 w-11 items-center justify-center rounded text-navy/40 transition-colors hover:bg-surface-raised hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            title="Remove"
            aria-label="Remove"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {(li.noteOpen || hasNote) && (
        <textarea
          rows={2}
          maxLength={2000}
          value={li.note ?? ""}
          onChange={(e) => onSetNote(e.target.value)}
          aria-label="Line note"
          placeholder="Flavor or note for this item (prints on invoice)"
          className="mt-1 w-full resize-y rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      )}

      {pendingUnit && <PendingUnitStatus pending={pendingUnit} />}

      <Fold summary={<span className="text-xs font-medium text-navy/60">More</span>}>
        <div className="space-y-2 pb-1 pt-1">
          {unitSlot && <div>{unitSlot}</div>}
          {inlinePrice && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-navy/70">
                {li.unitsPerBox && li.unitsPerBox > 1 ? "Case price:" : "Price:"}
              </span>
              <MoneyInput
                min={0}
                placeholder={li.listPrice.toFixed(2)}
                value={li.discountedPrice ?? null}
                onChange={(v) => onSetDiscountedPrice(v)}
                disabled={qtyLocked}
                className="w-20 rounded border border-surface-border bg-white px-1.5 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}
          {!li.isUnlisted && (
            <MarginHint
              unitPrice={li.unitPrice}
              unitCost={li.unitCost}
              unitsPerBox={li.unitsPerBox}
              productId={li.productId || undefined}
              floor={marginFloor}
              acked={floorAcked}
              onSetToFloor={onSetToFloor}
              onSellAnyway={onAckFloor}
              concealed={!costRevealed}
              onToggleConcealed={onToggleCostRevealed}
            />
          )}
        </div>
      </Fold>
    </li>
  );
}
