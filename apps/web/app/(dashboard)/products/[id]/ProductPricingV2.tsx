"use client";

import * as React from "react";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { useUndoPrices } from "@/lib/api/usePriceWrites";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { ChangePrices } from "./units-v2/change-prices/ChangePrices";
import { PriceSaveStatusLine } from "./units-v2/confirm/SaveStatusLine";
import { usePriceUndo } from "./units-v2/confirm/usePriceUndo";
import { EditablePricesGrid } from "./units-v2/edit/EditablePricesGrid";
import { PriceDraftProvider } from "./units-v2/edit/PriceDraftProvider";
import { PriceEditBar } from "./units-v2/edit/PriceEditBar";
import { usePriceDraft, type PriceDraftHooks } from "./units-v2/edit/usePriceDraft";

/**
 * Shell for the units v2 pricing surface (rendered by the page behind `flag.units_prices_v2`, so
 * everything new lives here and flag off renders nothing of it). One shared draft per product.
 */
export function ProductPricingV2({
  product,
  onOpenChangePrices,
  changePricesOpen,
  onSaved,
  onEdit,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  /** K4's Change prices opener (the button renders only when passed). */
  onOpenChangePrices?: () => void;
  changePricesOpen?: boolean;
} & PriceDraftHooks) {
  return (
    <PriceDraftProvider productId={product.id} onSaved={onSaved} onEdit={onEdit}>
      <ChangePrices />
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={onOpenChangePrices}
        changePricesOpen={changePricesOpen}
      />
      <SaveStatus productId={product.id} />
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
    current:
      served?.revision == null
        ? null
        : { revision: served.revision, priceState: served.priceState },
    mutate: undoPrices.mutateAsync,
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
