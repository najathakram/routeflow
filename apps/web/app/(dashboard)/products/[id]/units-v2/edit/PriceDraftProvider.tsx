"use client";

import * as React from "react";
import { PriceDraftContext, useCreatePriceDraft, type PriceDraftHooks } from "./usePriceDraft";

export { usePriceDraftOptional } from "./usePriceDraft";

/**
 * One draft per product page; K3's grid, K4's panels, K5 and K6 all read it through usePriceDraft(). K11-20: the page may
 * mount it above both the inline section and the floating window (ProductPricingV2 then uses it instead of its own);
 * `usePriceDraftOptional()` reads it without throwing when there is none.
 */
export function PriceDraftProvider({
  productId,
  children,
  ...hooks
}: PriceDraftHooks & {
  productId: string;
  children: React.ReactNode;
}) {
  const draft = useCreatePriceDraft(productId, hooks);
  return <PriceDraftContext.Provider value={draft}>{children}</PriceDraftContext.Provider>;
}
