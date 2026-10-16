"use client";

import * as React from "react";
import { GRID_BORDER } from "../../ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { usePriceDraft } from "./usePriceDraft";

/** Why the order unit cannot be switched yet (U-1 owns the rules; the server refuses with PRICING_RULES_NOT_READY). */
export const ORDER_UNIT_SWITCH_OFF = "Available after units settings update";

/**
 * V06: the order unit control. Switching it waits for U-1, so in edit mode it stays visible but disabled
 * (aria-disabled, never silently gone) with the reason beside it. It shows the current order unit, read-only.
 */
export function OrderUnitDraft() {
  const { grid } = usePriceDraft();
  const reasonId = React.useId();
  if (!grid) return null;
  return (
    <div className="mt-3 text-sm text-navy">
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-navy/60">
          Order unit
        </span>
        <select
          data-testid={T.orderUnit}
          aria-disabled="true"
          aria-describedby={reasonId}
          title={ORDER_UNIT_SWITCH_OFF}
          value={grid.anchor}
          onChange={() => {}}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key !== "Tab") e.preventDefault();
          }}
          className={`h-9 cursor-not-allowed rounded-md border bg-white px-2.5 text-sm text-navy opacity-60 ${GRID_BORDER}`}
        >
          {[...grid.rows]
            .sort((a, b) => b.factor - a.factor)
            .map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.label}
              </option>
            ))}
        </select>
      </label>
      <p id={reasonId} data-testid={T.orderUnitReason} className="mt-1 text-xs text-navy/55">
        {ORDER_UNIT_SWITCH_OFF}
      </p>
    </div>
  );
}
