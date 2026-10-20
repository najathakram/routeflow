"use client";

import * as React from "react";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { useUndoPrices } from "@/lib/api/usePriceWrites";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { CustomerPriceView } from "./units-v2/customer/CustomerPriceView";
import { ChangePrices, useChangePrices } from "./units-v2/change-prices/ChangePrices";
import { PriceSaveStatusLine } from "./units-v2/confirm/SaveStatusLine";
import { usePriceUndo } from "./units-v2/confirm/usePriceUndo";
import { EditablePricesGrid } from "./units-v2/edit/EditablePricesGrid";
import { PriceDraftProvider, usePriceDraftOptional } from "./units-v2/edit/PriceDraftProvider";
import { PriceEditBar } from "./units-v2/edit/PriceEditBar";
import {
  usePriceDraft,
  type EditSurface,
  type PriceDraftHooks,
} from "./units-v2/edit/usePriceDraft";
import { UnitRowRemove, UnitStructureControls } from "./units-v2/structure/UnitStructure";
import { UnitDetailsEditor, UnitsBesideGrid } from "./units-v2/structure/UnitsBesideGrid";
import { useUnitStructureAllowed } from "./units-v2/structure/unit-structure";

/**
 * Shell for the units v2 pricing surface (rendered by the page behind `flag.units_prices_v2`, so
 * everything new lives here and flag off renders nothing of it). One shared draft per product.
 *
 * K11-20: when the page mounts a PriceDraftProvider above this (so the floating price window shares the draft) this
 * section uses it; otherwise it creates its own. `onSaved` / `onEdit` belong to the provider that owns the draft, so with
 * an outer provider they are that provider's.
 */
export function ProductPricingV2({
  product,
  onSaved,
  onEdit,
}: {
  product: UnitsCardProduct & {
    msrp?: number | string | null;
    kind?: string | null;
    parentProductId?: string | null;
  };
} & PriceDraftHooks) {
  const outer = usePriceDraftOptional();
  const section = <PricingSection product={product} />;
  return outer ? (
    section
  ) : (
    <PriceDraftProvider productId={product.id} onSaved={onSaved} onEdit={onEdit}>
      {section}
    </PriceDraftProvider>
  );
}

function PricingSection({
  product,
}: {
  product: UnitsCardProduct & {
    msrp?: number | string | null;
    kind?: string | null;
    parentProductId?: string | null;
  };
}) {
  const cp = useChangePrices();
  // K10d: Add a unit / Remove / Reset to Auto (+ the default order unit and Name / Contains beside the grid), only where the unit ladder can be edited.
  const structure = useUnitStructureAllowed(product);
  return (
    <>
      {/* K12 F02: the "Units and prices" jump lands here, on the row that starts with Change prices / Edit,
          not on the grid title below it. */}
      {/* The jump focuses this row's wrapper: name it by the grid title so focus is announced. */}
      <div data-units-jump-anchor="" role="group" aria-labelledby="units-v2-grid-title">
        <EditablePricesGrid
          product={product}
          onOpenChangePrices={cp.enabled ? cp.toggle : undefined}
          changePricesOpen={cp.open}
          changePricesRef={cp.opener}
          panel={<ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />}
          unitControls={
            structure ? (
              <>
                <UnitStructureControls productId={product.id} />
                <UnitsBesideGrid product={product} />
              </>
            ) : undefined
          }
          afterGrid={structure ? <UnitDetailsEditor product={product} /> : undefined}
          rowAction={
            structure
              ? (row, layout) => <UnitRowRemove productId={product.id} row={row} layout={layout} />
              : undefined
          }
        />
      </div>
      {/* K13: per-unit Name / Contains (edit mode) render in the grid's afterGrid slot, right under the card, so entering
          edit never moves its rows and Name / Contains read straight under the units they name. */}
      {/* K13 P09: the Save bar rests directly under the grid it saves, not below the Customer view block. */}
      <PriceEditBar changePricesOpen={cp.open} />
      <PriceSaveStatus productId={product.id} surface="inline" />
      <CustomerViewSlot productId={product.id} />
    </>
  );
}

/**
 * K13: the Customer view steps aside while prices are edited inline and returns on Save or Cancel. The jump strip is
 * built from the DOM, so its "Customer view" entry disappears with the section and comes back with it.
 */
export function CustomerViewSlot({ productId }: { productId: string }) {
  const draft = usePriceDraft();
  if (draft.editingIn === "inline") return null;
  return <CustomerPriceView productId={productId} />;
}

/**
 * V07: the one Undo. `current` is the SERVED grid query (the cache a save and a refetch write), not a draft snapshot.
 * K11-20: shows only a save made in `surface` (the section's own line is "inline"; whoever hosts the floating window
 * renders "window" where the save should be reported), so one save never has two lines or two Undos. Only the inline line
 * stays mounted while idle: the page keeps one live region (K11-20c).
 */
export function PriceSaveStatus({
  productId,
  surface,
}: {
  productId: string;
  surface: EditSurface;
}) {
  const draft = usePriceDraft();
  const lastSave = draft.lastSave?.surface === surface ? draft.lastSave : null;
  const served = usePriceGrid(productId).data;
  const undoPrices = useUndoPrices(productId);
  const undo = usePriceUndo({
    lastSave,
    current: served ?? null,
    mutate: undoPrices.mutateAsync,
    conflictRow: draft.conflictRow,
    loadPreview: draft.loadUndoPreview,
  });
  return (
    <PriceSaveStatusLine
      id={surface === "inline" ? "units-msg" : `units-msg-${surface}`}
      idleUnmounted={surface !== "inline"}
      lastSave={lastSave}
      dirty={draft.dirty}
      undo={undo}
      onUndone={draft.markUndone}
    />
  );
}
