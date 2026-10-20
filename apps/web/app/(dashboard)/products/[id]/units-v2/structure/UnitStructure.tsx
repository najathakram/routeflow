"use client";

import * as React from "react";
import { priceGrid, validateSetPrice } from "@routeflow/pricing";
import type { ProductPriceGridDto, ProductPriceGridRowDto } from "@routeflow/types";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import { takeAddUnitIntent, useAddUnitIntent } from "../edit/add-unit-intent";
import { usePriceDraft } from "../edit/usePriceDraft";
import { rulesFromGrid, viewFromGrid } from "../edit/view-from-grid";
import {
  AddUnitPanel,
  DIRTY_HINT,
  RemoveUnitControl,
  ResetToAutoPanel,
  type AddedUnit,
} from "../units";

/**
 * K10d: K7's unit panels mounted in the v2 shell (V15, V17). Everything here reads the ONE shared price draft:
 * a dirty draft disables all three (the unit writes go straight to the API, so they wait for Save or Discard),
 * and Reset to Auto folds into that same draft. The panels render in normal flow, so they sit under the Change
 * prices panel and above the grid, and never under the save bar.
 */

const PRICE_NOT_KEPT = "Unit added. Type its price in the grid.";

/**
 * K11-19: the two openers share one row (8px gap; wrap on a narrow screen). An opened panel takes the full row below
 * them: the panel is inside its opener's item, so the ROW keys on `:has(panel)` and AddUnitPanel / ResetToAutoPanel stay
 * untouched. When both are open they stack in the order they were opened: the later one gets a higher `order`, read from
 * `data-last-opened`, which the row sets from the opener clicks.
 *
 * Every class below is written out whole, on purpose: Tailwind builds its CSS by scanning this file's TEXT, so a class
 * assembled from a template string (a `has-[...]` variant with a hole in it) is never generated and the panels came out narrower than the
 * row and in DOM order. The selectors are per item (`:has(panel)`), never `[&>*]`, so an opener with no panel is left
 * alone. `UnitStructure.k11-19.test.tsx` compiles this very file.
 */
const OPENER_ROW =
  "mt-3 max-sm:mt-0 flex flex-wrap items-start gap-2 " +
  "[&>*:has([data-testid=units-v2-add-panel])]:order-last " +
  "[&>*:has([data-testid=units-v2-add-panel])]:basis-full " +
  "[&>*:has([data-testid=units-v2-add-panel])]:w-full " +
  "[&>*:has([data-testid=units-v2-add-panel])]:min-w-0 " +
  "[&>*:has([data-testid=units-v2-reset-panel])]:order-last " +
  "[&>*:has([data-testid=units-v2-reset-panel])]:basis-full " +
  "[&>*:has([data-testid=units-v2-reset-panel])]:w-full " +
  "[&>*:has([data-testid=units-v2-reset-panel])]:min-w-0 " +
  "[&[data-last-opened=add]>*:has([data-testid=units-v2-add-panel])]:order-[10000] " +
  "[&[data-last-opened=reset]>*:has([data-testid=units-v2-reset-panel])]:order-[10000]";

/** Add a unit + Reset all to Auto, above the grid. */
export function UnitStructureControls({ productId }: { productId: string }) {
  const draft = usePriceDraft();
  const gridQuery = usePriceGrid(productId);
  const served = gridQuery.data;
  const [pendingPrice, setPendingPrice] = React.useState<AddedUnit | null>(null);
  const [note, setNote] = React.useState("");
  const [focusBar, setFocusBar] = React.useState(false);
  // K11-19: which opener was used last, so two open panels stack in opener order (see OPENER_ROW).
  // K11-19: the one unsaved-changes hint for the opener row; both disabled openers point at it.
  const hintId = React.useId();
  const [lastOpened, setLastOpened] = React.useState<"add" | "reset" | null>(null);

  // F07 / K11-11: the grid's "Add the Piece unit first" pointer sets the shared intent for the span of its click on
  // the opener, and the opener's onOpen reads and clears it: only the pointer opens the form already set up as that Piece.
  const intent = useAddUnitIntent();
  const [prefillPiece, setPrefillPiece] = React.useState(false);

  // A price typed in Add a unit: the unit is created WITHOUT it. The create call refetches the grid before it reports
  // back, so the FIRST settled grid after the add decides, once: if it serves the new unit (matched by its id, never by
  // name) and the draft is clean, that unit's Retail box opens as a draft holding the text and the normal save bar
  // commits it (CAS, audit, undo). If the refetch failed, the row is missing, or the draft is no longer clean, nothing
  // is injected, ever: the price is dropped and the user is told to type it. No write happens here.
  const { startEditing } = draft;
  const setText = draft.api.setText;
  const gridFetching = gridQuery.isFetching === true;
  const gridFailed = gridQuery.isError === true;
  React.useEffect(() => {
    if (!pendingPrice || gridFetching) return;
    setPendingPrice(null);
    const row = gridFailed ? undefined : served?.rows.find((r) => r.ref === pendingPrice.id);
    if (!row || !row.editable || draft.dirty) {
      setNote(PRICE_NOT_KEPT);
      return;
    }
    startEditing({ ref: row.ref, tier: 1, layout: visibleLayout() });
    setText(row.ref, 1, pendingPrice.price, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrice, served, gridFetching, gridFailed]);

  // The note is about a moment that has passed once the user starts typing in the grid.
  const draftCount = draft.count;
  React.useEffect(() => {
    if (draftCount > 0) setNote("");
  }, [draftCount]);

  // After Reset's Apply the panel and its opener step aside (the draft is dirty, so the opener is disabled): put focus
  // on the save bar, which is where the user goes next, once it exists.
  const editing = draft.editing;
  React.useEffect(() => {
    if (!focusBar || !editing) return;
    const t = setTimeout(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="units-v2-editbar"]');
      // Save, by id: it is aria-disabled while nothing is saveable, so "first enabled button" would land on Cancel.
      const save = bar?.querySelector<HTMLElement>('[data-testid="units-v2-eb-save"]');
      (save ?? bar)?.focus({ preventScroll: false });
      setFocusBar(false);
    }, 0);
    return () => clearTimeout(t);
  }, [focusBar, editing]);

  // The note is a live region: mounted before it has anything to say, so a screen reader announces the text.
  const noteRegion = (
    <p
      role="status"
      data-testid="units-v2-add-note"
      className={note ? "mt-2 text-sm text-navy/80" : "text-sm text-navy/80"}
    >
      {note}
    </p>
  );

  if (!served || served.rows.length === 0) return noteRegion;

  const rows = [...served.rows].sort((a, b) => a.factor - b.factor);
  const base = rows.find((r) => r.kind === "base");
  const ofUnits = rows
    .filter((r) => r !== base)
    .map((r) => ({ label: r.label, factorToBase: r.factor }));
  const pieceMissing = pieceIsMissing(rows);
  const anchor = served.rows.find((r) => r.ref === served.anchor);
  const reset = resetPreview(served);

  return (
    <div data-testid="units-v2-structure" className="mb-3 max-sm:mb-2">
      <div
        data-testid="units-v2-structure-row"
        data-last-opened={lastOpened ?? undefined}
        className={OPENER_ROW}
        onClickCapture={(e) => {
          const hit = e.target instanceof Element ? e.target : null;
          if (hit?.closest('[data-testid="units-v2-add-open"]')) setLastOpened("add");
          else if (hit?.closest('[data-testid="units-v2-reset-open"]')) setLastOpened("reset");
        }}
      >
        <AddUnitPanel
          productId={productId}
          baseLabel={base?.label ?? "Piece"}
          ofUnits={ofUnits}
          dirty={draft.dirty}
          hideHint
          hintId={hintId}
          pieceMissing={pieceMissing}
          prefillPiece={prefillPiece}
          validatePrice={cellPriceProblem}
          onOpen={() => {
            setNote("");
            setPrefillPiece(takeAddUnitIntent(intent));
          }}
          onAdded={(added) => {
            setNote("");
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
            hideHint
            hintId={hintId}
            preview={<ResetPreview rows={reset.rows} />}
          />
        )}
      </div>
      {draft.dirty && (
        <p id={hintId} className="mt-2 text-xs text-navy/70" data-testid="units-v2-structure-hint">
          {DIRTY_HINT}
        </p>
      )}
      {noteRegion}
    </div>
  );
}

/**
 * True when the grid shows a base (Piece) row that no unit backs yet. The signal is structural, not the server's wording:
 * the implicit Piece row is the one row locked while another row of the grid is still editable. A family, recipe or
 * variant product locks EVERY row, so it never reads as a missing Piece.
 */
function pieceIsMissing(rows: ProductPriceGridRowDto[]): boolean {
  const base = rows.find((r) => r.kind === "base");
  return (
    base != null && base.editable === false && rows.some((r) => r.kind !== "base" && r.editable)
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
  layout,
}: {
  productId: string;
  row: ProductPriceGridRowDto;
  /** The grid draws each row twice (table and phone card); the panel ids carry the layout so they stay unique. */
  layout: "table" | "card";
}) {
  const draft = usePriceDraft();
  if (row.kind !== "unit" || !row.editable) return null;
  return (
    <div className="max-w-[16rem] whitespace-normal text-left text-sm font-normal">
      <RemoveUnitControl
        productId={productId}
        unit={{ id: row.ref, label: row.label }}
        dirty={draft.dirty}
        panelKey={layout}
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
