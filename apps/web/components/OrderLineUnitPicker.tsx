"use client";

import * as React from "react";
import { UnitPicker } from "@/components/UnitPicker";
import { useProductUnits, useUnitsEnabled } from "@/lib/api/product-units";
import { buildUnitOptions, type UnitOption } from "@/lib/unit-options";
import { ladderProductOf, type PackBase } from "@/lib/order-line-unit";

/** The line fields the picker reads (structurally satisfied by the order modal's line). */
export interface OrderLineUnitPickerLine {
  productId: string;
  productName: string;
  isUnlisted?: boolean;
  unit: string;
  unitsPerBox?: number;
  listPrice: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  unitLabel?: string;
  packBase?: PackBase;
  tierPrices?: Parameters<typeof ladderProductOf>[0]["tierPrices"];
}

/**
 * The "Sell by" control on one order line (units_v1, step 5b). Owns the per-row hooks (the flag and
 * the product's ladder) so the modal's `.map()` never calls a hook. Renders nothing unless the tenant
 * has `flag.units_v1` AND the product has levels — every other tenant/product sees today's row.
 *
 * `onChange(option, refresh)`: `refresh` is true when the SAME unit is being re-priced (the customer's
 * tier changed under a unit line), so the caller keeps the typed count.
 */
export function OrderLineUnitPicker({
  line,
  tier,
  onChange,
}: {
  line: OrderLineUnitPickerLine;
  /** The EFFECTIVE tier for this product (`CustomerPrice.pricingTier ?? customer.pricingTier ?? 1`). */
  tier: number;
  onChange: (option: UnitOption, refresh: boolean) => void;
}) {
  const enabled = useUnitsEnabled();
  const units = useProductUnits(line.productId, enabled && !line.isUnlisted && !!line.productId);
  const product = React.useMemo(
    () => ladderProductOf(line),
    // the pack inputs only change with the product / its snapshot, never with the sold unit
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [line.unit, line.unitsPerBox, line.listPrice, line.packBase, line.tierPrices],
  );
  const packPrice = line.packBase?.unitPrice ?? line.unitPrice;
  const options = React.useMemo<UnitOption[]>(() => {
    if (!enabled || !units.data || units.data.length === 0) return [];
    try {
      return buildUnitOptions(product, units.data, tier, packPrice);
    } catch {
      return []; // display-only: a bad tier never unmounts the order form (the server 400s on save)
    }
  }, [enabled, units.data, product, tier, packPrice]);

  // The customer's tier changed under a unit line: refresh its ladder price. A one-time price the
  // operator typed (DISCOUNTED / MANUAL) is theirs and stands.
  const held = options.find((o) => o.value === (line.unitLabel ?? ""));
  React.useEffect(() => {
    if (!line.unitLabel || !held) return;
    if (line.priceType === "DISCOUNTED" || line.priceType === "MANUAL") return;
    if (held.price !== line.unitPrice) onChange(held, true);
  }, [line.unitLabel, line.priceType, line.unitPrice, held, onChange]);

  return (
    <UnitPicker
      product={product}
      units={units.data}
      tier={tier}
      packPrice={packPrice}
      ariaLabel={`Sell ${line.productName} by`}
      value={line.unitLabel ?? ""}
      onChange={(label) => {
        const option = options.find((o) => o.value === label);
        if (option) onChange(option, false);
      }}
    />
  );
}
