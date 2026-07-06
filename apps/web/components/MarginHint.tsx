"use client";

import * as React from "react";
import {
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
  costPerSellingUnit,
} from "@/lib/pricing";

/**
 * Live cost/margin hint — the "negotiation floor" (pos-cost-roles-spec §1).
 * Shows `cost $X.XX · margin %` beneath a line's price. Below cost or below the
 * floor it turns red and offers a one-tap "Set to floor $Y" fix plus "Sell
 * anyway" (which the caller logs). Renders nothing when the cost is unknown.
 */
export function MarginHint({
  unitPrice,
  unitCost,
  unitsPerBox,
  floor,
  acked,
  onSetToFloor,
  onSellAnyway,
}: {
  unitPrice: number;
  unitCost: number | null | undefined;
  unitsPerBox?: number | null;
  floor: number;
  acked?: boolean;
  onSetToFloor?: (floorPrice: number) => void;
  onSellAnyway?: () => void;
}) {
  if (unitCost == null) return null;
  const margin = computeMarginFraction(unitPrice, unitCost, unitsPerBox);
  if (margin == null) return null;
  const cls = classifyMargin(margin, floor);
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  const below = cls === "belowFloor" || cls === "belowCost";
  const color = below ? "text-danger" : cls === "warn" ? "text-amber-600" : "text-navy/40";
  const floorPrice = priceForMarginFloor(Number(unitCost), floor, unitsPerBox);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`font-mono text-[10px] ${color}`}>
        cost ${cost.toFixed(2)} · {(margin * 100).toFixed(1)}%
      </span>
      {below && !acked && onSetToFloor && (
        <>
          <button
            type="button"
            onClick={() => onSetToFloor(floorPrice)}
            className="rounded border border-danger/30 px-1.5 py-0.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
          >
            Set to floor ${floorPrice.toFixed(2)}
          </button>
          {onSellAnyway && (
            <button
              type="button"
              onClick={onSellAnyway}
              className="text-[10px] font-semibold text-navy/50 underline underline-offset-2 hover:text-navy"
            >
              Sell anyway
            </button>
          )}
        </>
      )}
    </div>
  );
}
