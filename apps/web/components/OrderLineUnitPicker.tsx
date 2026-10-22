"use client";

import * as React from "react";
import { UnitPicker } from "@/components/UnitPicker";
import { useProductUnits, useUnitsEnabled } from "@/lib/api/product-units";
import {
  buildUnitOptions,
  defaultUnitValue,
  withLayerPrices,
  type OwnPackBasis,
  type UnitOption,
} from "@/lib/unit-options";
import { isShapedLine } from "@/lib/default-unit-line";
import { ladderProductOf, unitPickerValueOf, type PackBase } from "@/lib/order-line-unit";
import type { CustomerLayerUnit, DerivedBaseMarker } from "@routeflow/pricing";

/** The line fields the picker reads (structurally satisfied by the order modal's line). */
export interface OrderLineUnitPickerLine extends DerivedBaseMarker {
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
  /**
   * S19b: this MANUAL line is the customer layer's own above-list price (`isLayerManualLine`), so it follows the ladder like any
   * system price. Absent or false = master: every MANUAL line is the operator's and the picker never re-prices it.
   */
  layerManual?: boolean;
  /**
   * Row 630: an EXISTING line's own pack price and size as stored (the order edit's loaded pack lines). Its derived Piece is
   * that price over that size, never the customer's live layer price over the product's current pack size. Absent = a fresh line.
   */
  ownPack?: OwnPackBasis | null;
}

/**
 * The "Sell by" control on one order line (units_v1, step 5b). Owns the per-row hooks (the flag and
 * the product's ladder) so the modal's `.map()` never calls a hook. Renders nothing unless the tenant
 * has `flag.units_v1` AND the product has levels — every other tenant/product sees today's row.
 *
 * `onChange(option, refresh)`: `refresh` is true when the SAME unit is being re-priced (the customer's
 * tier changed under a unit line), so the caller keeps the typed count.
 */
function OrderLineUnitPickerInner({
  line,
  tier,
  layer,
  onChange,
  startOnDefaultUnit = false,
}: {
  line: OrderLineUnitPickerLine;
  /**
   * #2784: a NEW line (the picker tap / a scan) starts on the level flagged `isDefaultSelling`, else stays on the pack.
   * Applied once when the ladder first arrives, and never over a unit the line already holds or a price the operator typed.
   */
  startOnDefaultUnit?: boolean;
  /**
   * The EFFECTIVE tier for this product (`CustomerPrice.pricingTier ?? customer.pricingTier ?? 1`). This is the tier-ladder
   * price only: a flag-on customer's layer price (a typed price, or the customer's shape of it) is applied by the order
   * surface through `customerLinePrice` (S19b, SA-811a), never evaluated here.
   */
  tier: number;
  /**
   * S19b (SA-811a, SA-813): the customer's price-layer rows for this product (`useCustomerPriceLayer().layerOf`). Flag on, an
   * option with a row is offered at the layer price and `onChange` carries it (`option.layerLine`); omitted = master's ladder.
   */
  layer?: readonly CustomerLayerUnit[] | null;
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
  // a stable reference (the caller builds the object each render): the options below must not re-derive on every render
  const ownPack = React.useMemo(
    () => line.ownPack ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [line.ownPack?.unitPrice, line.ownPack?.unitsPerBox],
  );
  const options = React.useMemo<UnitOption[]>(() => {
    if (!enabled || !units.data || units.data.length === 0) return [];
    try {
      return withLayerPrices(
        buildUnitOptions(product, units.data, tier, packPrice),
        product,
        tier,
        layer,
        ownPack,
      );
    } catch {
      return []; // display-only: a bad tier never unmounts the order form (the server 400s on save)
    }
  }, [enabled, units.data, product, tier, packPrice, layer, ownPack]);

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
    if (line.priceType === "DISCOUNTED") return;
    // master: MANUAL is the operator's and stands; only the layer's own above-list price (marked by the surface) follows
    if (line.priceType === "MANUAL" && !line.layerManual) return;
    if (held.price !== line.unitPrice) onChange(held, true);
  }, [
    line.unitLabel,
    line.priceType,
    line.layerManual,
    line.unitPrice,
    line.priceEdited,
    held,
    onChange,
  ]);

  return (
    <UnitPicker
      product={product}
      units={units.data}
      tier={tier}
      packPrice={packPrice}
      layer={layer}
      ownPack={ownPack}
      ariaLabel={`Sell ${line.productName} by`}
      value={unitPickerValueOf(line)}
      onChange={(label) => {
        // "" = back to the pack, which must work even when the ladder is gone (no options to look in):
        // the held unit would otherwise be unfixable and the save would 400 on it.
        const option =
          options.find((o) => o.value === label) ??
          (label === "" ? withLayerPrices([packOption], product, tier, layer)[0] : undefined);
        if (option) onChange(option, false);
      }}
    />
  );
}

/**
 * The "Sell by" control (see `OrderLineUnitPickerInner`). Every surface passes the customer's layer rows as `layer` (a pin
 * spec, no-direct-customer-tier-price, fails a picker that omits it); the surface owns the unconfirmed-prices notice.
 */
export function OrderLineUnitPicker(props: React.ComponentProps<typeof OrderLineUnitPickerInner>) {
  return <OrderLineUnitPickerInner {...props} />;
}
