"use client";

import * as React from "react";
import { Select } from "@routeflow/ui/web";
import type { CustomerLayerUnit, LadderProduct } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import {
  buildUnitOptions,
  type OwnPackBasis,
  unitOptionText,
  withLayerPrices,
  type UnitOption,
} from "@/lib/unit-options";

export interface UnitPickerProps {
  product: LadderProduct;
  /** The product's ladder (`useProductUnits`). Undefined while loading → no picker. */
  units: readonly ProductUnitLevel[] | undefined;
  /**
   * The EFFECTIVE tier 1-5 for this product on this order — the server prices a unit line at
   * `CustomerPrice.pricingTier ?? customer.pricingTier`, so pass that, not the customer's tier alone. Tier ladder only: a
   * customer-layer price is picked by `customerLinePrice` (S19b, SA-811a) in the surface that owns the line.
   */
  tier?: number | string;
  /** The price the parent already shows for the pack (promotions / remembered upsell apply to it). */
  packPrice?: number;
  /** S19b: the customer's layer rows for this product (flag on): options with a row show the layer price. */
  layer?: readonly CustomerLayerUnit[] | null;
  /** Row 630: an EXISTING line's own pack price and size, so its derived Piece is not priced off the live layer. */
  ownPack?: OwnPackBasis | null;
  /** Accessible name; give each row's picker a distinct one (e.g. include the product name). */
  ariaLabel?: string;
  /** The `unitLabel` being sold; `""` = the pack. A stale label falls back to the pack. */
  value: string;
  onChange: (unitLabel: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Which unit a line is sold by (units_v1, step 5a). Renders NOTHING for a product without levels, so a
 * tenant without `flag.units_v1` (which never loads a ladder) and a product with no levels both see
 * today's UI byte for byte. Display only: the server re-resolves the factor and price by label.
 */
export function UnitPicker({
  product,
  units,
  tier = 1,
  packPrice,
  layer,
  ownPack,
  ariaLabel = "Sell by",
  value,
  onChange,
  disabled,
  id,
  className,
}: UnitPickerProps) {
  const { options, ok } = React.useMemo<{ options: UnitOption[]; ok: boolean }>(() => {
    if (!units) return { options: [], ok: false }; // still loading: nothing is known yet
    if (units.length === 0) return { options: [], ok: true };
    try {
      return {
        options: withLayerPrices(
          buildUnitOptions(product, units, tier, packPrice),
          product,
          tier,
          layer,
          ownPack,
        ),
        ok: true,
      };
    } catch {
      // display-only: a bad tier must never unmount the order form (the server 400s it on save)
      return { options: [], ok: false };
    }
  }, [product, units, tier, packPrice, layer, ownPack]);
  const known = options.some((o) => o.value === value);
  // A held label the ladder does not offer (product swapped, level deleted) would otherwise show the
  // pack — or nothing — while the parent still SENDS the stale label and the server 400s the save.
  // Tell the parent, never mask it; only once the ladder has loaded and resolved without error.
  React.useEffect(() => {
    if (ok && value && !known) onChange("");
  }, [ok, value, known, onChange]);
  if (options.length <= 1) return null;
  const selected = known ? value : "";
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      className={className}
      disabled={disabled}
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      options={options.map((o) => ({ value: o.value, label: unitOptionText(o) }))}
    />
  );
}
