"use client";

import * as React from "react";
import { PriceDraftContext, useCreatePriceDraft, type PriceDraftHooks } from "./usePriceDraft";

/** One draft per product page; K3's grid, K4's panels, K5 and K6 all read it through usePriceDraft(). */
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
