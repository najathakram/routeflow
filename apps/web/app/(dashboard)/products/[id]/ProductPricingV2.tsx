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
import { PriceDraftProvider } from "./units-v2/edit/PriceDraftProvider";
import { PriceEditBar } from "./units-v2/edit/PriceEditBar";
import { usePriceDraft, type PriceDraftHooks } from "./units-v2/edit/usePriceDraft";
import { UnitRowRemove, UnitStructureControls } from "./units-v2/structure/UnitStructure";
import { useUnitStructureAllowed } from "./units-v2/structure/unit-structure";

/**
 * Shell for the units v2 pricing surface (rendered by the page behind `flag.units_prices_v2`, so
 * everything new lives here and flag off renders nothing of it). One shared draft per product.
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
  const cp = useChangePrices();
  // K10d: Add a unit / Remove / Reset to Auto, only where the unit ladder can be edited.
  const structure = useUnitStructureAllowed(product);
  return (
    <PriceDraftProvider productId={product.id} onSaved={onSaved} onEdit={onEdit}>
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={cp.enabled ? cp.toggle : undefined}
        changePricesOpen={cp.open}
        changePricesRef={cp.opener}
        panel={<ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />}
        unitControls={structure ? <UnitStructureControls productId={product.id} /> : undefined}
        rowAction={
          structure
            ? (row, layout) => <UnitRowRemove productId={product.id} row={row} layout={layout} />
            : undefined
        }
      />
      <SaveStatus productId={product.id} />
      <CustomerPriceView productId={product.id} />
      <PriceEditBar />
    </PriceDraftProvider>
  );
}

/** V07: the one Undo. `current` is the SERVED grid query (the cache a save and a refetch write), not a draft snapshot. */
function SaveStatus({ productId }: { productId: string }) {
  const draft = usePriceDraft();
  const served = usePriceGrid(productId).data;
  const undoPrices = useUndoPrices(productId);
  const undo = usePriceUndo({
    lastSave: draft.lastSave,
    current: served ?? null,
    mutate: undoPrices.mutateAsync,
    conflictRow: draft.conflictRow,
    loadPreview: draft.loadUndoPreview,
  });
  return (
    <PriceSaveStatusLine
      lastSave={draft.lastSave}
      dirty={draft.dirty}
      undo={undo}
      onUndone={draft.markUndone}
    />
  );
}
