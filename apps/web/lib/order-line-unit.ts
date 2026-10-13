import {
  isSpecialTier,
  getTierPrice,
  normalizeBoxesPieces,
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
  ctx: { tier: number; keepQty?: boolean },
): T {
  // A derived-base line is the pack with a piece count: leave that shape first, so a snapshot or a restore
  // below always sees the PACK (never the pieces state).
  const line = li.derivedBase ? backToPack(li) : li;
  const base = line.packBase ?? snapshot(line);
  if (option.kind === "pack") {
    if (!line.packBase) return line;
    const { packBase, ...rest } = line;
    const restored = { ...rest, ...packBase, unitLabel: undefined } as T;
    // The snapshot's AUTO-derived price (tier / list) goes stale if the customer's tier moved while the
    // line sold by a unit — restoring it verbatim would show a price the server will not store. Only an
    // operator's one-time price (`discountedPrice`) is theirs to keep across the switch.
    if (packBase.discountedPrice == null && line.tierPrices) {
      const tierPrice = getTierPrice(line.tierPrices, ctx.tier);
      const special = isSpecialTier(ctx.tier);
      restored.unitPrice = tierPrice;
      restored.priceType = special ? "SPECIAL" : "STANDARD";
      restored.specialPrice = special ? tierPrice : undefined;
    }
    return restored;
  }
  const special = isSpecialTier(ctx.tier);
  if (option.derived) {
    // Units P0b: a DERIVED base unit bills as the pack line's pieces (computeLineSubtotal proration), never
    // qty x a rounded per-piece price — the same line the server stores for it.
    const keep = ctx.keepQty && li.derivedBase === option.value ? li.qty : 1;
    const n = normalizeBoxesPieces({ boxes: 0, pieces: keep, unitsPerBox: option.derived.n });
    return {
      ...line,
      derivedBase: option.value,
      unitLabel: undefined,
      unitsPerBox: option.derived.n,
      boxes: n.boxes ?? 0,
      pieces: n.pieces ?? 0,
      qty: n.qty,
      sellBy: "unit",
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
    priceType: special ? "SPECIAL" : "STANDARD",
    specialPrice: special ? option.price : undefined,
    discountedPrice: undefined,
    unitCost: base.unitCost != null ? base.unitCost * option.factorToBase : undefined,
  };
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
