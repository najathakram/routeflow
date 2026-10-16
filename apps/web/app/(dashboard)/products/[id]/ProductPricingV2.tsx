"use client";

import * as React from "react";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { ProductPricesGrid } from "./ProductPricesGrid";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { EditablePricing } from "./units-v2/edit/EditablePricing";

/**
 * Shell for the units v2 pricing surface (rendered by the page behind `flag.units_prices_v2`). With
 * the flag unserved (fail-closed) it is today's read-only grid, unchanged.
 */
export function ProductPricingV2({
  product,
  onOpenChangePrices,
  changePricesOpen,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  /** K4's Change prices panel opener (wired from the contract). */
  onOpenChangePrices?: () => void;
  changePricesOpen?: boolean;
}) {
  const on = usePricesV2Enabled();
  if (!on) return <ProductPricesGrid product={product} />;
  return (
    <EditablePricing
      product={product}
      onOpenChangePrices={onOpenChangePrices}
      changePricesOpen={changePricesOpen}
    />
  );
}
