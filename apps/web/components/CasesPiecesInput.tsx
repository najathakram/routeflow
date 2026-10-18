"use client";

import * as React from "react";
import type { UnitWords } from "@routeflow/pricing";

/**
 * #2696 (d): on a case-packed line in Case mode the loose-units field is OPT-IN ("+ units"), never
 * shown by default — so a new line submits pieces = 0. Shown whenever pieces > 0 regardless (an
 * edited line with boxes + pieces, or one switched back from Unit mode, never hides its units).
 * Shared by the row and the scan screen's PriceEditor so the two cannot drift.
 */
export function useLooseUnitsToggle(pieces: number | null | undefined) {
  const [open, setOpen] = React.useState(false);
  return {
    showLooseUnits: open || (pieces ?? 0) > 0,
    openLooseUnits: () => setOpen(true),
    closeLooseUnits: () => setOpen(false),
  };
}

export interface CasesPiecesInputProps {
  /** Whole cases; null/undefined reads as 0. */
  boxes: number | null | undefined;
  /** Loose pieces (< unitsPerBox); null/undefined reads as 0. */
  pieces: number | null | undefined;
  unitsPerBox: number;
  words: UnitWords;
  /** Locked while the line's selling unit loads. */
  disabled?: boolean;
  /** Raw parseInt of the typed value: may be NaN; the caller normalises (normalizeBoxesPieces). */
  onSetBoxes: (n: number) => void;
  onSetPieces: (n: number) => void;
}

/**
 * O1 (F06): the ONE cases + loose-pieces entry, lifted verbatim out of `LineItemRow` so Create
 * (`LineItemRow`) and Edit Items (`EditableLineItems`) render the same control. Keeps the opt-in
 * "+ units" toggle (`useLooseUnitsToggle`), the SA-563 rule that hides x at 0 cases, the hit-slop
 * and the narrow-width wrap. It owns no maths: callers normalise through @routeflow/pricing
 * `normalizeBoxesPieces`.
 *
 * Two no-wrap groups in a wrapping row: "[n] cases" and "+ [n] units" together need ~186px, but
 * under `sm` the column's track can be narrower (~170-182px at 320px). The second group drops to
 * its own line there instead of overflowing into the line total.
 */
export function CasesPiecesInput({
  boxes,
  pieces,
  unitsPerBox,
  words: w,
  disabled = false,
  onSetBoxes,
  onSetPieces,
}: CasesPiecesInputProps) {
  const { showLooseUnits, openLooseUnits, closeLooseUnits } = useLooseUnitsToggle(pieces);
  return (
    <div data-testid="line-qty-cases-row" className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <input
          disabled={disabled}
          type="number"
          min={0}
          value={boxes ?? 0}
          onChange={(e) => onSetBoxes(parseInt(e.target.value, 10))}
          onFocus={(e) => e.target.select()}
          className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
          title={`Number of whole ${w.pack.lowerOther}`}
        />
        <span
          className="min-w-0 max-w-[6rem] truncate text-xs text-navy/70"
          title={w.isDefaultPack ? undefined : w.pack.other}
        >
          {w.packFor(boxes ?? 0)}
        </span>
      </span>
      {showLooseUnits ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="text-xs text-navy/30">+</span>
          <input
            disabled={disabled}
            type="number"
            min={0}
            max={unitsPerBox - 1}
            value={pieces ?? 0}
            onChange={(e) => onSetPieces(parseInt(e.target.value, 10))}
            onFocus={(e) => e.target.select()}
            className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
            title={`Extra ${w.base.lowerOther} (less than a full ${w.pack.lower})`}
            aria-label={`Extra ${w.base.lowerOther}`}
          />
          <span
            className="min-w-0 max-w-[6rem] truncate text-xs text-navy/70"
            title={w.isDefaultBase ? undefined : w.base.other}
          >
            {w.baseShortFor(pieces ?? 0)}
          </span>
          {/* SA-563: hidden at 0 cases — the units ARE the line then, never a removable extra. */}
          {(boxes ?? 0) >= 1 && (
            <button
              disabled={disabled}
              type="button"
              onClick={() => {
                onSetPieces(0);
                closeLooseUnits();
              }}
              aria-label={`Remove extra ${w.base.lowerOther}`}
              className="relative before:absolute before:-inset-2 before:content-[''] text-xs text-navy/50 hover:text-danger"
            >
              ×
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={openLooseUnits}
          aria-label={`+ ${w.base.lowerOther}: add extra ${w.base.lowerOther}`}
          // hitSlop 8 (mobile parity, #2706): the pseudo-element grows the tap target, not the layout.
          className="relative before:absolute before:-inset-2 before:content-[''] whitespace-nowrap rounded border border-dashed border-surface-border px-1.5 py-0.5 text-[10px] font-medium text-navy/60 hover:bg-surface-raised"
        >
          + {w.base.lowerOther}
        </button>
      )}
    </div>
  );
}
