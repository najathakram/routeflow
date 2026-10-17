"use client";

import * as React from "react";
import type { ProductPriceGridRowDto } from "@routeflow/types";
import { ProductPricesGrid } from "../../ProductPricesGrid";
import type { UnitsCardProduct } from "../../ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { AlsoUpdatePanel } from "../change-prices/AlsoUpdatePanel";
import { AddUnitIntentProvider } from "./add-unit-intent";
import { OrderUnitDraft } from "./OrderUnitDraft";
import { BTN, SkipToSave } from "./PriceEditBar";
import { usePriceDraft } from "./usePriceDraft";

/**
 * The units v2 prices section with edit mode (S12a). V08: Edit and Change prices live in the section's
 * own actions and each price is a button that enters edit mode on its input. Every price consequence
 * comes from @routeflow/pricing through the draft; this file has no money math.
 */
export function EditablePricesGrid({
  product,
  onOpenChangePrices,
  changePricesOpen = false,
  changePricesRef,
  panel,
  unitControls,
  rowAction,
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
  /** K10d: a control under each unit's name (Remove). */
  rowAction?: (row: ProductPriceGridRowDto, layout: "table" | "card") => React.ReactNode;
}) {
  const d = usePriceDraft();
  const root = React.useRef<HTMLDivElement>(null);
  const editBtn = React.useRef<HTMLButtonElement>(null);
  const was = React.useRef(false);
  const { editing } = d;
  // Every row family-governed (each says `editable: false`): nothing to edit or change here.
  const anyEditable = d.grid?.rows.some((r) => r.editable) ?? true;
  const pendingFocus = d.api.focus;
  React.useEffect(() => {
    if (editing && !was.current && !pendingFocus) {
      // The Edit button unmounts with focus: land on the first VISIBLE price input (table or phone card).
      const inputs = [
        ...(root.current?.querySelectorAll<HTMLElement>('[data-testid^="units-v2-input-"]') ?? []),
      ];
      (inputs.find((i) => i.offsetParent !== null) ?? inputs[0])?.focus({ preventScroll: true });
    }
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
        {editing && <SkipToSave />}
        <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
          {editing && (
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
              id="btn-change-open"
              data-testid={T.btnChange}
              aria-expanded={changePricesOpen}
              aria-controls="change-panel"
              className={BTN}
              onClick={onOpenChangePrices}
            >
              Change prices
            </button>
          )}
          {!editing && anyEditable && (
            <button
              ref={editBtn}
              type="button"
              data-testid={T.btnEdit}
              className={BTN}
              onClick={() => d.startEditing()}
            >
              Edit
            </button>
          )}
        </div>
        {panel}
        {unitControls}
        <ProductPricesGrid product={product} edit={d.api} rowAction={rowAction} />
        {editing && <OrderUnitDraft />}
        {d.plan && <AlsoUpdatePanel plan={d.plan.plan} />}
      </div>
    </AddUnitIntentProvider>
  );
}
