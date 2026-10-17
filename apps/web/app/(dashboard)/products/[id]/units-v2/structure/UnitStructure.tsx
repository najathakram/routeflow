"use client";

import * as React from "react";
import { priceGrid, validateSetPrice } from "@routeflow/pricing";
import type { ProductPriceGridDto, ProductPriceGridRowDto } from "@routeflow/types";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import { usePriceDraft } from "../edit/usePriceDraft";
import { rulesFromGrid, viewFromGrid } from "../edit/view-from-grid";
import { AddUnitPanel, RemoveUnitControl, ResetToAutoPanel, type AddedUnit } from "../units";

/**
 * K10d: K7's unit panels mounted in the v2 shell (V15, V17). Everything here reads the ONE shared price draft:
 * a dirty draft disables all three (the unit writes go straight to the API, so they wait for Save or Discard),
 * and Reset to Auto folds into that same draft. The panels render in normal flow, so they sit under the Change
 * prices panel and above the grid, and never under the save bar.
 */

/** Add a unit + Reset all to Auto, above the grid. */
export function UnitStructureControls({ productId }: { productId: string }) {
  const draft = usePriceDraft();
  const served = usePriceGrid(productId).data;
  const [pendingPrice, setPendingPrice] = React.useState<AddedUnit | null>(null);
  const [focusBar, setFocusBar] = React.useState(false);

  // A price typed in Add a unit: the unit is created WITHOUT it. Once the grid has refetched and serves the new row, its
  // Retail box opens as a draft holding that text, and the normal save bar commits it (CAS, audit, undo). No write here.
  const newRow = pendingPrice
    ? served?.rows.find((r) => r.ref === pendingPrice.id || r.label === pendingPrice.label)
    : undefined;
  const { startEditing } = draft;
  const setText = draft.api.setText;
  React.useEffect(() => {
    if (!pendingPrice || !newRow || !newRow.editable) return;
    setPendingPrice(null);
    startEditing({ ref: newRow.ref, tier: 1, layout: visibleLayout() });
    setText(newRow.ref, 1, pendingPrice.price, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrice, newRow]);

  // After Reset's Apply the panel and its opener step aside (the draft is dirty, so the opener is disabled): put focus
  // on the save bar, which is where the user goes next, once it exists.
  const editing = draft.editing;
  React.useEffect(() => {
    if (!focusBar || !editing) return;
    const t = setTimeout(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="units-v2-editbar"]');
      const first = bar?.querySelector<HTMLElement>(
        "button:not([disabled]), [href], input, select",
      );
      (first ?? bar)?.focus({ preventScroll: false });
      setFocusBar(false);
    }, 0);
    return () => clearTimeout(t);
  }, [focusBar, editing]);

  if (!served || served.rows.length === 0) return null;

  const rows = [...served.rows].sort((a, b) => a.factor - b.factor);
  const base = rows.find((r) => r.kind === "base");
  const ofUnits = rows
    .filter((r) => r !== base)
    .map((r) => ({ label: r.label, factorToBase: r.factor }));
  const anchor = served.rows.find((r) => r.ref === served.anchor);
  const reset = resetPreview(served);

  return (
    <div data-testid="units-v2-structure" className="mb-3 space-y-3">
      <AddUnitPanel
        productId={productId}
        baseLabel={base?.label ?? "Piece"}
        ofUnits={ofUnits}
        dirty={draft.dirty}
        validatePrice={cellPriceProblem}
        onAdded={(added) => {
          if (added.price !== "") setPendingPrice(added);
        }}
      />
      {reset.rows.length > 0 && (
        <ResetToAutoPanel
          disabled={draft.dirty}
          onApply={() => {
            if (draft.dirty) return;
            // The draft's reset only fills the draft: open edit mode too, so the save bar is there to Save or Cancel.
            draft.startEditing();
            draft.resetAllToAuto();
            setFocusBar(true);
          }}
          changedCount={reset.rows.length}
          anchorName={anchor?.label}
          dirty={draft.dirty}
          preview={<ResetPreview rows={reset.rows} />}
        />
      )}
    </div>
  );
}

/** The grid cell's own rule for a typed price (null = fine, blank included), so the panel refuses with the same words. */
function cellPriceProblem(text: string): string | null {
  const checked = validateSetPrice(text);
  return checked.ok ? null : checked.message;
}

/** The grid renders a table from 768px and phone cards below; the layout whose input is on screen takes the focus. */
function visibleLayout(): "table" | "card" {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(min-width: 768px)").matches === false
    ? "card"
    : "table";
}

/** After a finished Remove the row is going away: focus the units heading, which stays. */
function focusUnitsHeading() {
  document.getElementById("units-v2-grid-title")?.focus();
}

/** A unit row's Remove button and its confirm. Only the unit rows can be removed, never Case/Piece. */
export function UnitRowRemove({
  productId,
  row,
}: {
  productId: string;
  row: ProductPriceGridRowDto;
}) {
  const draft = usePriceDraft();
  if (row.kind !== "unit" || !row.editable) return null;
  return (
    <div className="max-w-[16rem] whitespace-normal text-left text-sm font-normal">
      <RemoveUnitControl
        productId={productId}
        unit={{ id: row.ref, label: row.label }}
        dirty={draft.dirty}
        onRemoved={focusUnitsHeading}
      />
    </div>
  );
}

interface ResetRow {
  key: string;
  unit: string;
  tier: string;
  from: string;
  to: string;
}

/**
 * Every typed (Set) price the reset would clear, with what Auto makes of it. The Auto figures come from the pricing
 * package (priceGrid on the ladder with those prices cleared), so no money math lives here. The anchor unit's Retail
 * price is kept, exactly as the draft's reset keeps it.
 */
function resetPreview(grid: ProductPriceGridDto): { rows: ResetRow[] } {
  const view = viewFromGrid(grid);
  const cleared = {
    ...view,
    rows: view.rows.map((r) => ({
      ...r,
      set: r.set.map((v, i) => (r.ref === view.anchor && i === 0 ? v : null)),
    })),
  };
  const after = priceGrid(cleared, rulesFromGrid(grid));
  const rows: ResetRow[] = [];
  for (const r of view.rows) {
    for (let t = 1; t <= 5; t++) {
      if (r.set[t - 1] == null || (r.ref === view.anchor && t === 1)) continue;
      const now = grid.rows.find((x) => x.ref === r.ref)?.cells.find((c) => c.tier === t);
      const auto = after.find((x) => x.ref === r.ref)?.cells.find((c) => c.tier === t);
      rows.push({
        key: `${r.ref}-${t}`,
        unit: r.label,
        tier: t === 1 ? "Retail" : `Tier ${t}`,
        from: formatMoney(now?.value ?? 0),
        to: formatMoney(auto?.value ?? 0),
      });
    }
  }
  return { rows };
}

function ResetPreview({ rows }: { rows: ResetRow[] }) {
  return (
    <table data-testid="units-v2-reset-preview" className="w-full text-left text-xs text-navy">
      <thead className="text-[11px] uppercase tracking-wide text-navy/60">
        <tr>
          <th scope="col" className="py-1 pr-2 font-medium">
            Price
          </th>
          <th scope="col" className="py-1 pr-2 font-medium">
            Now
          </th>
          <th scope="col" className="py-1 font-medium">
            Auto
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row" className="py-0.5 pr-2 text-left font-normal">
              {r.unit} {r.tier}
            </th>
            <td className="py-0.5 pr-2 tabular-nums">{r.from}</td>
            <td className="py-0.5 tabular-nums">{r.to}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
