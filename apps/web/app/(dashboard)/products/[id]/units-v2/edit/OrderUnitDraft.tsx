"use client";

import * as React from "react";
import { formatMoney } from "@/lib/format";
import { GRID_BORDER } from "../../ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { usePriceDraft } from "./usePriceDraft";

/**
 * V06: the order unit is picked in edit mode as a DRAFT. The review sits directly under the control:
 * what moves, a Keep per Auto price, and a quiet "Undo switch". There is no Apply; Save commits.
 */
export function OrderUnitDraft() {
  const d = usePriceDraft();
  const { grid, sw } = d;
  if (!grid) return null;
  const label = (ref: string) => grid.rows.find((r) => r.ref === ref)?.label ?? ref;
  const kept = (sw?.pins ?? []).filter((p) =>
    d.keeps.some((k) => k.ref === p.ref && k.tier === p.tier),
  );
  const anchorPin = sw?.pins.find((p) => p.ref === sw.to && p.tier === 1 && !kept.includes(p));
  return (
    <div className="mt-3 text-sm text-navy">
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-navy/60">
          Order unit
        </span>
        <select
          data-testid={T.orderUnit}
          className={`h-9 rounded-md border bg-white px-2.5 text-sm text-navy ${GRID_BORDER}`}
          value={d.orderUnit ?? grid.anchor}
          onChange={(e) => d.setOrderUnit(e.target.value === grid.anchor ? null : e.target.value)}
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
      {sw && (
        <div data-testid={T.switchReview} className={`mt-2 rounded-md border p-3 ${GRID_BORDER}`}>
          <p>
            Orders now use the {label(sw.to)}.{" "}
            {sw.changes.length === 0
              ? "No Auto prices changed. "
              : `${sw.changes.length} Auto ${sw.changes.length === 1 ? "price" : "prices"} changed. `}
            Prices you set stay as they are.
          </p>
          {anchorPin && (
            <p>
              {label(sw.to)} Retail is now set at {formatMoney(anchorPin.value)}.
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {sw.changes.map((c) => (
              <li key={`${c.ref}|${c.tier}`} className="flex items-center justify-between gap-2">
                <span>
                  {c.label} {d.tierName(c.tier)}: {formatMoney(c.from)} to {formatMoney(c.to)}
                </span>
                <button
                  type="button"
                  aria-label={`Keep ${c.label} ${d.tierName(c.tier)} at ${formatMoney(c.from)}`}
                  className="text-xs font-medium text-brand-700 underline"
                  onClick={() => d.keep({ ref: c.ref, tier: c.tier, value: c.from })}
                >
                  Keep {formatMoney(c.from)}
                </button>
              </li>
            ))}
            {kept.map((p) => (
              <li key={`k${p.ref}|${p.tier}`} className="flex items-center justify-between gap-2">
                <span>
                  {label(p.ref)} {d.tierName(p.tier)}: kept at {formatMoney(p.value)}
                </span>
                <button
                  type="button"
                  aria-label={`Release ${label(p.ref)} ${d.tierName(p.tier)}`}
                  className="text-xs font-medium text-navy/70 underline"
                  onClick={() => d.unkeep(p)}
                >
                  Release
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid={T.switchUndo}
            className="mt-2 text-xs text-navy/60 underline hover:text-navy"
            onClick={() => d.setOrderUnit(null)}
          >
            Undo switch
          </button>
        </div>
      )}
    </div>
  );
}
