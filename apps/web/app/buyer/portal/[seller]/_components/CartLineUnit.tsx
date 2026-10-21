"use client";

import * as React from "react";
import {
  CASE_LABEL,
  EACH_LABEL,
  canSellByCase,
  isBoxedLine,
  lineQtyText,
  lineUnit,
  type CartLineShape,
  type CartUnit,
} from "@/lib/buyer-cart-line";

/**
 * Row 531: what a buyer's stepper counts. Under every boxed cart line (shop tile, product page,
 * cart row) it always names the unit and the quantity it means ("2 Cases (24 ea)"), and a visible
 * Case / Each toggle switches the stepper and the label together. The line's `qty` (pieces) is
 * unchanged by the toggle, so the subtotal never moves. A line holding loose pieces cannot switch
 * to Case (that would round money), so the Case button is disabled with the reason on hover.
 * A product that is not boxed has one unit and renders nothing.
 */
export function CartLineUnit({
  item,
  name,
  onUnit,
  className = "",
}: {
  item: CartLineShape;
  /** Product name, for the accessible names. */
  name: string;
  onUnit: (unit: CartUnit) => void;
  className?: string;
}) {
  if (!isBoxedLine(item)) return null;
  const unit = lineUnit(item);
  const caseDisabled = unit !== "CASE" && !canSellByCase(item);
  const seg = (active: boolean) =>
    `flex min-h-11 min-w-11 items-center justify-center px-3 text-xs font-semibold transition-colors ${
      active ? "bg-buyer-500 text-white" : "bg-white text-buyer-700 hover:bg-buyer-50"
    } disabled:cursor-not-allowed disabled:opacity-50`;
  return (
    <div data-testid="cart-line-unit" className={`flex flex-col gap-1 ${className}`}>
      <p
        data-testid="cart-line-qty-text"
        className="text-[11px] font-medium tabular-nums text-navy/70"
      >
        {lineQtyText(item)}
      </p>
      <div
        role="group"
        aria-label={`Sold by, ${name}`}
        className="inline-flex w-fit overflow-hidden rounded-lg border border-buyer-200"
      >
        <button
          type="button"
          aria-pressed={unit === "CASE"}
          aria-label={`Order ${name} by the ${CASE_LABEL}`}
          disabled={caseDisabled}
          title={caseDisabled ? "Remove the loose pieces to order by the Case." : undefined}
          onClick={() => onUnit("CASE")}
          className={seg(unit === "CASE")}
        >
          {CASE_LABEL}
        </button>
        <button
          type="button"
          aria-pressed={unit === "EACH"}
          aria-label={`Order ${name} by the ${EACH_LABEL.toLowerCase()}`}
          onClick={() => onUnit("EACH")}
          className={seg(unit === "EACH")}
        >
          {EACH_LABEL}
        </button>
      </div>
    </div>
  );
}

export default CartLineUnit;
