"use client";

import * as React from "react";
import type { PriceTier } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { formatMoney } from "@/lib/format";
import { EDIT_TESTIDS as E } from "./edit-testids";
import type { GridEditState } from "./useGridEdit";

const FIELD =
  "h-9 rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

/**
 * V06: the order unit is picked in edit mode as a DRAFT. The review sits directly under the control:
 * what moves, a Keep per Auto price, and a quiet "Undo switch". There is no Apply; Save commits.
 */
export function OrderUnitDraft({
  data,
  edit,
  tierName,
}: {
  data: ProductPriceGridDto;
  edit: GridEditState;
  tierName: (t: PriceTier) => string;
}) {
  const sw = edit.plan?.sw ?? null;
  const current = edit.switchTo ?? data.anchor;
  const to = sw ? data.rows.find((r) => r.ref === sw.to) : undefined;
  const kept = (sw?.pins ?? []).filter((p) => edit.keeps.includes(`${p.ref}|${p.tier}`));
  const label = (ref: string) => data.rows.find((r) => r.ref === ref)?.label ?? ref;
  return (
    <div className="mt-3 text-sm text-navy">
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-navy/60">
          Order unit
        </span>
        <select
          data-testid={E.orderUnit}
          className={FIELD}
          value={current}
          onChange={(e) => edit.setSwitchTo(e.target.value === data.anchor ? null : e.target.value)}
        >
          {[...data.rows]
            .sort((a, b) => b.factor - a.factor)
            .map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.label}
              </option>
            ))}
        </select>
      </label>
      {sw && to && (
        <div
          data-testid={E.switchReview}
          className="mt-2 rounded-md border border-surface-border bg-surface-muted/50 p-3"
        >
          <p>
            Orders now use the {to.label}.{" "}
            {sw.changes.length === 0
              ? "No Auto prices changed. "
              : `${sw.changes.length} Auto ${sw.changes.length === 1 ? "price" : "prices"} changed. `}
            Prices you set stay as they are.
          </p>
          <ul className="mt-2 space-y-1">
            {sw.changes.map((c) => (
              <li key={`${c.ref}|${c.tier}`} className="flex items-center justify-between gap-2">
                <span>
                  {c.label} {tierName(c.tier)}: {formatMoney(c.from)} to {formatMoney(c.to)}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-brand-700 underline"
                  onClick={() => edit.toggleKeep(c.ref, c.tier)}
                >
                  Keep {formatMoney(c.from)}
                </button>
              </li>
            ))}
            {kept.map((p) => (
              <li key={`k${p.ref}|${p.tier}`} className="flex items-center justify-between gap-2">
                <span>
                  {label(p.ref)} {tierName(p.tier)}: kept at {formatMoney(p.value)}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-navy/70 underline"
                  onClick={() => edit.toggleKeep(p.ref, p.tier)}
                >
                  Release
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid={E.switchUndo}
            className="mt-2 text-xs text-navy/60 underline hover:text-navy"
            onClick={() => edit.setSwitchTo(null)}
          >
            Undo switch
          </button>
        </div>
      )}
    </div>
  );
}
