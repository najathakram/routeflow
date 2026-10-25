"use client";

import * as React from "react";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { DecimalInput } from "@/components/MoneyInput";

/**
 * Row 688 (SA-827 §1/§4): a boxed line is edited in the unit it was SOLD in — whole boxes plus loose
 * pieces at the line's own stored pack — never as one total-pieces "Qty" beside the per-box price.
 * The line keeps `qty` in total pieces; this only reads and writes it through the split.
 */
export function SoldUnitQty({
  qty,
  unitsPerBox,
  onQtyChange,
  inputClassName,
}: {
  qty: number;
  unitsPerBox: number;
  onQtyChange: (qty: number) => void;
  inputClassName: string;
}) {
  const split = normalizeBoxesPieces({ qty, unitsPerBox });
  const boxes = split.boxes ?? 0;
  const pieces = split.pieces ?? 0;
  // Row 711: Boxes over Pieces, stacked, so both fit the 70 px Qty column with their labels. Side by side they
  // overflowed under Unit Price and Pieces could not be reached by mouse.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <DecimalInput
          aria-label="Boxes"
          decimals={0}
          min={0}
          value={boxes}
          onChange={(v) => onQtyChange(Math.trunc(v ?? 0) * unitsPerBox + pieces)}
          className={inputClassName}
        />
        <span className="shrink-0 text-xs text-navy/60">box</span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <DecimalInput
          aria-label="Pieces"
          decimals={0}
          min={0}
          // Row 708: loose pieces cap at pack - 1 (mobile's stepper max), so typing never rolls them into a box.
          max={unitsPerBox - 1}
          value={pieces}
          onChange={(v) => onQtyChange(boxes * unitsPerBox + Math.trunc(v ?? 0))}
          className={inputClassName}
        />
        <span className="shrink-0 text-xs text-navy/60" title={`${unitsPerBox} pieces per box`}>
          pcs
        </span>
      </div>
    </div>
  );
}
