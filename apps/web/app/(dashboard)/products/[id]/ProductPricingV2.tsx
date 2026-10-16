"use client";

import * as React from "react";
import { ProductPricesGrid } from "./ProductPricesGrid";
import type { UnitsCardProduct } from "./ProductUnitsCard";

/** Shell for the units v2 pricing surface (rendered by the page behind `flag.units_prices_v2`). */
export function ProductPricingV2({
  product,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  /** K4's Change prices panel opener (wired from the contract). */
  onOpenChangePrices?: () => void;
  changePricesOpen?: boolean;
}) {
  return <ProductPricesGrid product={product} />;
}
