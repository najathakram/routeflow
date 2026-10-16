"use client";

import * as React from "react";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { EditablePricesGrid } from "./units-v2/edit/EditablePricesGrid";
import { PriceDraftProvider } from "./units-v2/edit/PriceDraftProvider";
import { PriceEditBar } from "./units-v2/edit/PriceEditBar";
import type { PriceDraftHooks } from "./units-v2/edit/usePriceDraft";

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
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={onOpenChangePrices}
        changePricesOpen={changePricesOpen}
      />
      {/* Mount slot (K5): the save status line (V07) renders here, fed by onSaved / onEdit. */}
      <PriceEditBar />
    </PriceDraftProvider>
  );
}
