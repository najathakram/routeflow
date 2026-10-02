"use client";

import * as React from "react";
import { UnitPicker } from "@/components/UnitPicker";
import { useProductUnits, useUnitsEnabled } from "@/lib/api/product-units";
import { buildUnitOptions, defaultUnitValue, type UnitOption } from "@/lib/unit-options";
import { isShapedLine } from "@/lib/default-unit-line";
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
  /** #2784: the operator's own override fields: the start-on-default rule never touches a shaped line. */
  discountedPrice?: number;
  /** Informational only: on a boxed line this is TOTAL PIECES, so the start-on-default rule never guards on it. */
  qty?: number;
  unitLabel?: string;
  packBase?: PackBase;
  tierPrices?: Parameters<typeof ladderProductOf>[0]["tierPrices"];
  /** #2381: the operator TYPED this line's price this session. The first-sight refresh (which
   *  re-runs on every remount, e.g. "Not available" → Undo) must not snap it back to the ladder. */
  priceEdited?: boolean;
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
  startOnDefaultUnit = false,
}: {
  line: OrderLineUnitPickerLine;
  /**
   * #2784: a NEW line (the picker tap / a scan) starts on the level flagged `isDefaultSelling`, else stays on the pack.
   * Applied once when the ladder first arrives, and never over a unit the line already holds or a price the operator typed.
   */
  startOnDefaultUnit?: boolean;
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

  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (!startOnDefaultUnit || startedRef.current || options.length === 0) return;
    startedRef.current = true; // one shot per mount: the operator's later choice is never re-overridden
    // Only a line whose price the operator has not shaped (Opus #2865 B1/r2). Qty is NOT a guard: on a boxed line it is total
    // pieces (a fresh 1-box line is 24); the modal clears the flag in every qty/price handler instead.
    if (isShapedLine(line) || !units.data) return;
    const value = defaultUnitValue(product, units.data, tier);
    const option = value ? options.find((o) => o.value === value) : undefined;
    if (option) onChange(option, false);
  }, [
    startOnDefaultUnit,
    options,
    units.data,
    product,
    tier,
    line.unitLabel,
    line.priceEdited,
    line.discountedPrice,
    line.priceType,
    onChange,
  ]);

  const packOption: UnitOption = {
    value: "",
    label: line.packBase?.unit ?? line.unit,
    factorToBase: line.packBase?.unitsPerBox ?? line.unitsPerBox ?? 1,
    kind: "pack",
    price: packPrice,
    listPrice: line.packBase?.listPrice ?? line.listPrice,
  };

  // The customer's tier changed under a unit line: refresh its ladder price. A one-time price the
  // operator typed (DISCOUNTED / MANUAL) is theirs and stands.
  //
  // #2305: refresh only when the LADDER price moves (first sight of the held unit, or a tier/unit
  // change), never because `line.unitPrice` moved. The order-edit price row sets only `unitPrice`
  // (priceType stays STANDARD), so re-checking on every price change snapped a typed price straight
  // back to the ladder's and Save then sent nothing.
  const held = options.find((o) => o.value === (line.unitLabel ?? ""));
  const lastLadderPrice = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (!line.unitLabel || !held) return;
    const firstSight = lastLadderPrice.current === undefined;
    const ladderMoved = lastLadderPrice.current !== held.price;
    lastLadderPrice.current = held.price;
    if (!ladderMoved) return;
    // #2381: a remount (or a ladder arriving late) is a first sight, not a ladder move; a price
    // the operator typed stands. A real move afterwards (the tier changed) still re-prices.
    if (firstSight && line.priceEdited) return;
    if (line.priceType === "DISCOUNTED" || line.priceType === "MANUAL") return;
    if (held.price !== line.unitPrice) onChange(held, true);
  }, [line.unitLabel, line.priceType, line.unitPrice, line.priceEdited, held, onChange]);

  return (
    <UnitPicker
      product={product}
      units={units.data}
      tier={tier}
      packPrice={packPrice}
      ariaLabel={`Sell ${line.productName} by`}
      value={line.unitLabel ?? ""}
      onChange={(label) => {
        // "" = back to the pack, which must work even when the ladder is gone (no options to look in):
        // the held unit would otherwise be unfixable and the save would 400 on it.
        const option =
          options.find((o) => o.value === label) ?? (label === "" ? packOption : undefined);
        if (option) onChange(option, false);
      }}
    />
  );
}
