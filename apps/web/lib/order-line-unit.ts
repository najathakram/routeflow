import {
  isSpecialTier,
  getTierPrice,
  customerLinePrice,
  normalizeBoxesPieces,
  type CustomerLayerUnit,
  type CustomerLinePrice,
  type DerivedBaseMarker,
  type LadderProduct,
} from "@routeflow/pricing";
import type { UnitOption } from "@/lib/unit-options";

/**
 * Selling an order line by a unit (units_v1, step 5b). A unit line is a PLAIN-QUANTITY line whose
 * quantity is a count of that unit and whose price is per unit: no boxes / pieces / case-unit toggle,
 * so every existing per-line calculation (line total, qty stepper, margin hint) is already correct
 * for it. The server re-resolves the factor and price from the ladder by label; this only shapes
 * what the operator sees and sends `{ productId, qty: count, unitLabel }`.
 */

/** The fields a unit switch overwrites — snapshotted ONCE so switching back restores the pack exactly. */
export interface PackBase {
  unit: string;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  sellBy?: "case" | "unit";
  /** The catalog price a typed one-time price is compared against: the pack's, or the unit's TIER-1 price. */
  listPrice: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  specialPrice?: number;
  discountedPrice?: number;
  unitCost?: number;
}

/**
 * The line fields this module reads/writes (structurally satisfied by the modal's LineItem).
 *
 * `derivedBase` (Units P0b / SA-728) comes from the shared `DerivedBaseMarker` in @routeflow/pricing, declared once for
 * web and mobile: the base option's value while the line sells a DERIVED base unit. Such a line is a PACK-PIECES line
 * (boxes/pieces, `sellBy: "unit"`, no `unitLabel`) so the preview and the payload are the server's own proration; this
 * marker only keeps the picker showing the base. Never submitted.
 */
export interface UnitLine extends PackBase, DerivedBaseMarker {
  unitLabel?: string;
  packBase?: PackBase;
  /** The product's tier-price columns (the modal's snapshot) — lets a restored pack line be re-priced. */
  tierPrices?: Parameters<typeof getTierPrice>[0];
}

const snapshot = (li: PackBase): PackBase => ({
  unit: li.unit,
  qty: li.qty,
  unitsPerBox: li.unitsPerBox,
  boxes: li.boxes,
  pieces: li.pieces,
  sellBy: li.sellBy,
  listPrice: li.listPrice,
  unitPrice: li.unitPrice,
  priceType: li.priceType,
  specialPrice: li.specialPrice,
  discountedPrice: li.discountedPrice,
  unitCost: li.unitCost,
});

/**
 * Switch a line to `option`. Choosing the pack restores the snapshot (and forgets it); choosing a
 * level snapshots the pack once, then sets a unit line: count 1 (or, with `keepQty`, the current count —
 * only when the unit is unchanged, i.e. a price refresh), the ladder price at `tier`, no one-time override, and the
 * margin-hint cost per UNIT (per-piece cost x pieces in the unit — the row treats `unitCost` as the
 * cost of one sold unit once `unitsPerBox` is gone).
 */
export function applyLineUnit<T extends UnitLine>(
  li: T,
  option: UnitOption,
  ctx: { tier: number; keepQty?: boolean; layer?: readonly CustomerLayerUnit[] | null },
): T {
  // A derived-base line is the pack with a piece count: leave that shape first, so a snapshot or a restore
  // below always sees the PACK (never the pieces state).
  const line = li.derivedBase ? backToPack(li) : li;
  const base = line.packBase ?? snapshot(line);
  if (option.kind === "pack") {
    if (!line.packBase) return line;
    const back = restorePack(line, ctx, false);
    // S19b: the picker's pack option carries the customer's layer price; a one-time price the operator typed stands.
    return option.layerLine && back.discountedPrice == null
      ? withLayerLine(back, option.layerLine)
      : back;
  }
  const special = isSpecialTier(ctx.tier);
  if (option.derived) {
    // Units P0b: a DERIVED base unit bills as the pack line's pieces (computeLineSubtotal proration), never
    // qty x a rounded per-piece price — the same line the server stores for it. It starts from the PACK: a line
    // held on a level (a Case) gets its pack back first, with the level's price and one-time price gone, so the
    // preview and the bill are the pack's tier price prorated (SA: Case $190 -> Piece is $6.67, not $63.33).
    let pack = restorePack(line, ctx, true, option.derived.packPrice);
    // S19b: the picker's derived option carries the layer's PACK price (the Piece bills as the pack's proration).
    if (option.layerLine) pack = withLayerLine(pack, option.layerLine);
    const keep = ctx.keepQty && li.derivedBase === option.value ? li.qty : 1;
    const n = normalizeBoxesPieces({ boxes: 0, pieces: keep, unitsPerBox: option.derived.n });
    return {
      ...pack,
      derivedBase: option.value,
      unitLabel: undefined,
      unitsPerBox: option.derived.n,
      boxes: n.boxes ?? 0,
      pieces: n.pieces ?? 0,
      qty: n.qty,
      sellBy: "unit",
      discountedPrice: undefined,
    } as T;
  }
  return {
    ...line,
    packBase: base,
    unitLabel: option.value,
    unit: option.label,
    unitsPerBox: undefined,
    boxes: undefined,
    pieces: undefined,
    sellBy: undefined,
    qty: ctx.keepQty && line.unitLabel === option.value ? line.qty : 1,
    listPrice: option.listPrice,
    unitPrice: option.price,
    // S19b: an option from the customer's layer carries its own priceType and baseline (MANUAL when above list).
    priceType: option.layerLine ? option.layerLine.priceType : special ? "SPECIAL" : "STANDARD",
    specialPrice: option.layerLine
      ? customerLineSpecial(option.layerLine)
      : special
        ? option.price
        : undefined,
    discountedPrice: undefined,
    unitCost: base.unitCost != null ? base.unitCost * option.factorToBase : undefined,
  };
}

/**
 * The line back on its pack: the snapshot restored (and forgotten). The snapshot's AUTO-derived price (tier / list)
 * goes stale if the customer's tier moved while the line sold by a unit — restoring it verbatim would show a price
 * the server will not store — so it is re-taken at the tier; only an operator's one-time price (`discountedPrice`)
 * is theirs to keep across a plain switch back. `dropOneTime` (the derived-Piece start) discards that too: the
 * pieces are billed at the pack's tier price, never at a one-time price typed for another unit.
 */
function restorePack<T extends UnitLine>(
  line: T,
  ctx: { tier: number; layer?: readonly CustomerLayerUnit[] | null },
  dropOneTime: boolean,
  /** The pack price the picker already shows at the customer's tier: the fallback when the line has no tier columns. */
  shownPackPrice?: number,
): T {
  const { packBase, ...rest } = line;
  const pb = packBase ?? snapshot(line);
  const restored = { ...rest, ...pb, unitLabel: undefined } as T;
  if (dropOneTime) {
    restored.discountedPrice = undefined;
    if (!line.tierPrices) {
      // No tier columns on the line: the price the derived option shows (the pack at the customer's tier), else the
      // snapshot's list price (tier 1). A special-tier customer must never fall back to the tier-1 price.
      restored.unitPrice = shownPackPrice ?? pb.listPrice;
      const special = shownPackPrice != null && isSpecialTier(ctx.tier);
      restored.priceType = special ? "SPECIAL" : "STANDARD";
      restored.specialPrice = special ? shownPackPrice : undefined;
    }
  }
  if ((dropOneTime || pb.discountedPrice == null) && line.tierPrices) {
    // S19b: through customerLinePrice. With no layer (flag off, or none for this product) it is `getTierPrice` at the tier
    // and `isSpecialTier`, exactly as before; a layer row for the pack is the customer's price (SA-811a R1).
    const lp = customerLinePrice({
      product: line.tierPrices as unknown as Record<string, unknown>,
      tier: ctx.tier,
      layer: ctx.layer,
    });
    restored.unitPrice = lp.price;
    if (lp.layered) {
      restored.listPrice = lp.listPrice ?? restored.listPrice;
      restored.priceType = lp.priceType;
      restored.specialPrice = customerLineSpecial(lp);
    } else {
      restored.priceType = lp.priceType === "MANUAL" ? "STANDARD" : lp.priceType;
      restored.specialPrice = lp.isSpecial ? lp.price : undefined;
    }
  }
  return restored;
}

/** The special (baseline) price a layered line carries: the layer price, so a typed change is judged against it. */
export const customerLineSpecial = (lp: CustomerLinePrice): number | undefined =>
  lp.isSpecial || lp.priceType === "MANUAL" ? lp.price : undefined;

function withLayerLine<T extends PackBase>(line: T, lp: CustomerLinePrice): T {
  return {
    ...line,
    unitPrice: lp.price,
    listPrice: lp.listPrice ?? line.listPrice,
    priceType: lp.priceType,
    specialPrice: customerLineSpecial(lp),
  };
}

/** What a line was priced at before the customer's layer took it: restored when the layer's row goes away. */
export interface LayerFrom {
  unitPrice: number;
  listPrice: number;
  priceType: PackBase["priceType"];
  specialPrice?: number;
}

/** The line fields `repriceLineFromLayer` reads and writes. */
export interface LayerPricedLine extends UnitLine {
  isUnlisted?: boolean;
  /** A price the SYSTEM pre-filled from last-given history (not the operator): the layer replaces it once known. */
  systemPrefill?: boolean;
  overrideReason?: string;
  /** Set while the layer prices this line; the pre-layer values to restore if the row disappears. */
  layerFrom?: LayerFrom;
}

/** The pre-layer (master) pack values of a line, for `layerFrom`. */
export function masterLayerFrom(
  tierPrices: NonNullable<UnitLine["tierPrices"]>,
  tier: number,
): LayerFrom {
  const m = customerLinePrice({ product: tierPrices as unknown as Record<string, unknown>, tier });
  return {
    unitPrice: m.price,
    listPrice: Number(m.listPrice),
    priceType: m.priceType,
    specialPrice: customerLineSpecial(m),
  };
}

/**
 * S19b (SA-811a R1/R3): re-price an AUTO-priced line (no one-time `discountedPrice`) from the customer's price layer.
 * Idempotent, and a no-op when the product has no layer row for the line's unit (flag off, no typed price): master's
 * price stands. A layered row sets the unit price, list, priceType (MANUAL when above list) and the special baseline.
 * A derived-base (Piece) line is the pack's proration, so it takes the layer's PACK price. A price the system pre-filled from
 * last-given history (`systemPrefill`) yields to the layer; an operator-typed one-time price stands. A row that goes away
 * (new layer data) puts the line back to the values it had before the layer (`layerFrom`): master's number.
 */
export function repriceLineFromLayer<T extends LayerPricedLine>(
  li: T,
  ctx: { tier: number; layer?: readonly CustomerLayerUnit[] | null },
): T {
  if (!ctx.layer || li.isUnlisted || !li.tierPrices) return li;
  const prefilled = li.discountedPrice != null && !!li.systemPrefill;
  if (li.discountedPrice != null && !prefilled) return li;
  const lp = customerLinePrice({
    product: ladderProductOf(li) as unknown as Record<string, unknown>,
    tier: ctx.tier,
    layer: ctx.layer,
    unitLabel: li.unitLabel ?? null,
  });
  if (!lp.layered) {
    if (!li.layerFrom) return li;
    const { layerFrom, ...rest } = li;
    return { ...rest, ...layerFrom } as T;
  }
  const specialPrice = customerLineSpecial(lp);
  if (
    !prefilled &&
    li.unitPrice === lp.price &&
    li.listPrice === lp.listPrice &&
    li.priceType === lp.priceType &&
    li.specialPrice === specialPrice
  ) {
    return li;
  }
  const { systemPrefill: _s, overrideReason: _r, ...rest } = li;
  return {
    ...(prefilled ? rest : li),
    discountedPrice: undefined,
    unitPrice: lp.price,
    listPrice: lp.listPrice,
    priceType: lp.priceType,
    specialPrice,
    layerFrom:
      li.layerFrom ??
      (prefilled
        ? masterLayerFrom(li.tierPrices, ctx.tier)
        : {
            unitPrice: li.unitPrice,
            listPrice: li.listPrice,
            priceType: li.priceType,
            specialPrice: li.specialPrice,
          }),
  } as T;
}

/** A derived-base line back on the pack: one whole pack, the case entry mode, the marker gone. */
function backToPack<T extends UnitLine>(li: T): T {
  const upb = li.unitsPerBox;
  const { derivedBase: _gone, ...rest } = li;
  return {
    ...rest,
    sellBy: "case",
    ...(upb ? { qty: upb, boxes: 1, pieces: 0 } : {}),
  } as T;
}

/** What the unit picker shows as selected: the held unit, else the derived base, else the pack (`""`). */
export const unitPickerValueOf = (li: { unitLabel?: string } & DerivedBaseMarker): string =>
  li.unitLabel ?? li.derivedBase ?? "";

/** The pack ladder inputs of a line, whichever unit it currently sells by. */
export function ladderProductOf(li: {
  unit: string;
  unitsPerBox?: number;
  listPrice: number;
  packBase?: Pick<PackBase, "unit" | "unitsPerBox">;
  tierPrices?: {
    pricePerUnit: unknown;
    priceTier2?: unknown;
    priceTier3?: unknown;
    priceTier4?: unknown;
    priceTier5?: unknown;
  };
}): LadderProduct {
  const str = (v: unknown) => (v == null ? null : String(v));
  const t = li.tierPrices;
  return {
    unit: li.packBase?.unit ?? li.unit,
    unitsPerBox: li.packBase?.unitsPerBox ?? li.unitsPerBox ?? null,
    pricePerUnit: t ? String(t.pricePerUnit) : String(li.listPrice),
    priceTier2: t ? str(t.priceTier2) : null,
    priceTier3: t ? str(t.priceTier3) : null,
    priceTier4: t ? str(t.priceTier4) : null,
    priceTier5: t ? str(t.priceTier5) : null,
  };
}

/** The `unitLabel` field of a submitted line: present only when the line sells by a non-pack unit. */
export const unitLabelPayload = (li: { unitLabel?: string }): { unitLabel?: string } =>
  li.unitLabel ? { unitLabel: li.unitLabel } : {};

/** Same product AND same unit = the same line (a Case and a Box of one product are two lines). */
export const sameProductUnit = (
  a: { productId: string; unitLabel?: string } & DerivedBaseMarker,
  b: { productId: string; unitLabel?: string } & DerivedBaseMarker,
): boolean => a.productId === b.productId && unitPickerValueOf(a) === unitPickerValueOf(b);

/**
 * Fold `add` into `into` — two lines of the SAME product and unit become one. Unit lines add their
 * counts; pack lines add boxes and loose pieces and roll pieces over into boxes.
 */
export function mergeSameLine<
  T extends { qty: number; unitsPerBox?: number; boxes?: number; pieces?: number },
>(into: T, add: T): T {
  if (into.unitsPerBox) {
    const n = normalizeBoxesPieces({
      boxes: (into.boxes ?? 0) + (add.boxes ?? 0),
      pieces: (into.pieces ?? 0) + (add.pieces ?? 0),
      unitsPerBox: into.unitsPerBox,
    });
    return { ...into, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
  }
  return { ...into, qty: into.qty + add.qty };
}
