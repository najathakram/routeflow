"use client";

import * as React from "react";
import type { ProductPriceGridRowDto } from "@routeflow/types";
import {
  PricesTitle,
  ProductPricesGrid,
  type GridDensity,
  type GridLayout,
} from "../../ProductPricesGrid";
import type { UnitsCardProduct } from "../../ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { AlsoUpdatePanel } from "../change-prices/AlsoUpdatePanel";
import { AddUnitIntentProvider } from "./add-unit-intent";
import { OrderUnitDraft } from "./OrderUnitDraft";
import { revealClearOfBar } from "./reveal-clear-of-bar";
import { BTN, SkipToSave } from "./PriceEditBar";
import { usePriceDraft, type EditSurface } from "./usePriceDraft";
import type { GridEditApi } from "./edit-types";

/**
 * The units v2 prices section with edit mode (S12a). V08: Edit and Change prices live in the section's
 * own actions and each price is a button that enters edit mode on its input. Every price consequence
 * comes from @routeflow/pricing through the draft; this file has no money math.
 *
 * K11-20: `surface` says which editor this instance is. It shows edit mode only while the draft edits in ITS surface;
 * the "window" instance (the floating price editor) has no Edit button and no Editing pill (the window is the signal),
 * and takes an instance suffix for every fixed id, so the inline instance keeps today's ids exactly.
 */
export function EditablePricesGrid({
  product,
  onOpenChangePrices,
  changePricesOpen = false,
  changePricesRef,
  panel,
  unitControls,
  afterGrid,
  rowAction,
  surface = "inline",
  idSuffix,
  layout,
  density,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  /** K4's Change prices opener; the button renders only when it is passed. */
  onOpenChangePrices?: () => void;
  changePricesOpen?: boolean;
  /** The Change prices button's ref, for V17's focus return. */
  changePricesRef?: React.Ref<HTMLButtonElement>;
  /** Rendered right under the actions row (K4's Change prices panel). */
  panel?: React.ReactNode;
  /** K10d: Add a unit and Reset to Auto, rendered under `panel` and above the grid. */
  unitControls?: React.ReactNode;
  /** K13: rendered directly after the grid card, before the order-unit footer and the also-update panel (Name / Contains). */
  afterGrid?: React.ReactNode;
  /** K10d: a control under each unit's name (Remove). */
  rowAction?: (row: ProductPriceGridRowDto, layout: "table" | "card") => React.ReactNode;
  /** K11-20: which editor this is. Default "inline" (the page's own section). */
  surface?: EditSurface;
  /** K11-20: suffix for the ids this instance owns. Default: none for "inline", a generated one for "window". */
  idSuffix?: string;
  /** K11-20: forwarded to the grid ("auto" follows the viewport). */
  layout?: GridLayout;
  density?: GridDensity;
}) {
  const d = usePriceDraft();
  const root = React.useRef<HTMLDivElement>(null);
  const editBtn = React.useRef<HTMLButtonElement>(null);
  const was = React.useRef(false);
  const uid = React.useId();
  const sfx = idSuffix ?? (surface === "window" ? `-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}` : "");
  // Edit mode here only while the draft edits in THIS surface.
  const editing = d.editingIn === surface;
  const nobodyEditing = d.editingIn === null;
  // The grid sees this surface's edit state: another surface's draft shows here as the saved prices.
  const edit: GridEditApi = {
    ...d.api,
    editing,
    begin: (cell) => d.startEditing(cell, surface),
    rows: editing ? d.api.rows : null,
  };
  // Every row family-governed (each says `editable: false`): nothing to edit or change here.
  const anyEditable = d.grid?.rows.some((r) => r.editable) ?? true;
  const pendingFocus = d.api.focus;
  React.useEffect(() => {
    if (editing && !was.current) {
      // K11-13: a price the user opened (Enter or a click on it) is the target, recorded by `begin` before this render.
      const targeted = d.beginTarget.current !== null || pendingFocus;
      d.beginTarget.current = null;
      if (!targeted) {
        // The Edit button unmounts with focus: land on the first VISIBLE price input (table or phone card).
        const inputs = [
          ...(root.current?.querySelectorAll<HTMLElement>('[data-testid^="units-v2-input-"]') ??
            []),
        ];
        const first = inputs.find((i) => i.offsetParent !== null) ?? inputs[0];
        first?.focus({ preventScroll: true });
        revealClearOfBar(first ?? null);
      }
    }
    if (!editing) d.beginTarget.current = null;
    if (
      !editing &&
      was.current &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      editBtn.current?.focus({ preventScroll: true });
    }
    was.current = editing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  return (
    <AddUnitIntentProvider>
      <div ref={root} className="relative">
        {editing && surface === "inline" && <SkipToSave />}
        <div
          data-testid="units-v2-actions-row"
          data-wide-inset=""
          className="mb-2 flex flex-wrap items-center justify-end gap-2"
        >
          {/* K13: the region's heading leads the actions row, so on a phone it is one of the first things on the page. */}
          {surface === "inline" && (
            <PricesTitle id={`units-v2-grid-title${sfx}`} className="mr-auto" />
          )}
          {editing && surface === "inline" && (
            <span
              data-testid={T.editingPill}
              className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900"
            >
              Editing
            </span>
          )}
          {onOpenChangePrices && anyEditable && (
            <button
              ref={changePricesRef}
              type="button"
              id={`btn-change-open${sfx}`}
              data-testid={T.btnChange}
              aria-expanded={changePricesOpen}
              aria-controls={`change-panel${sfx}`}
              className={BTN}
              onClick={onOpenChangePrices}
            >
              Change prices
            </button>
          )}
          {surface === "inline" && nobodyEditing && anyEditable && (
            <button
              ref={editBtn}
              type="button"
              data-testid={T.btnEdit}
              // Visible name stays "Edit" (the removed price-window opener owned "Edit prices"); the region heading in
              // this row says what it edits.
              aria-describedby={`units-v2-grid-title${sfx}`}
              className={BTN}
              onClick={() => d.startEditing()}
            >
              Edit
            </button>
          )}
        </div>
        {panel}
        {unitControls ? (
          // `group` + data-panel: below sm the opener row drops its top margin only while Change prices is closed;
          // with the panel open above it the 12 px gap stays (K11-19).
          <div
            data-wide-inset=""
            data-panel={changePricesOpen ? "open" : "closed"}
            className="group"
          >
            {unitControls}
          </div>
        ) : null}
        <ProductPricesGrid
          product={product}
          edit={edit}
          rowAction={editing ? rowAction : undefined}
          layout={layout}
          density={density}
          idSuffix={sfx}
          hideTitle={surface === "inline"}
          // The window has no Add a unit control of its own; the pointer would click a hidden page control.
          addUnitPointers={surface !== "window"}
        />
        {afterGrid}
        {editing && <OrderUnitDraft />}
        {editing && d.plan && <AlsoUpdatePanel plan={d.plan.plan} />}
      </div>
    </AddUnitIntentProvider>
  );
}
