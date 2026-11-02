import { roundMoney } from "./pricing";
import { getTierPrice, TIER_FIELDS, type TierField } from "./tier-pricing";

/**
 * SA-1082 A-1: who a family price save asks about, and what a variant's blank box means. Each variant stores its own five
 * numbers and every billing reader keeps reading them; "at the family's price" is a comparison made at the moment of a
 * save, through `getTierPrice`'s effective values, scaled from a family that holds a pack and rounded once. Nothing here
 * writes, and nothing moves unless a person named the variant.
 */
export interface FamilyLadderRow {
  pricePerUnit: unknown;
  priceTier2?: unknown;
  priceTier3?: unknown;
  priceTier4?: unknown;
  priceTier5?: unknown;
  unitsPerBox?: unknown;
}

export interface VariantLadderRow extends FamilyLadderRow {
  /** The variant has its own order unit (or a tier unit that isn't the pack): its pack numbers come from that unit. */
  ownOrderUnit?: boolean;
  packAuto?: unknown;
}

const stored = (row: FamilyLadderRow, tier: number): number =>
  Number(row[TIER_FIELDS[tier - 1] as keyof FamilyLadderRow]) || 0;
const usable = (family: FamilyLadderRow): boolean => stored(family, 1) > 0;

const packOf = (units: unknown): number => Math.trunc(Number(units)) || 0;

/**
 * A family's price on a variant's pack, rounded once: the one place that scales (SA-1082 A-2). Only a family row holding a
 * pack above 1 has a per-piece rate. Families made in the editor or by import hold none, and a variant with no pack has
 * no pieces to scale by, so those take the number as it is.
 */
export function familyPriceOnPack(
  value: number,
  familyPack: unknown,
  variantPack: unknown,
): number {
  const from = packOf(familyPack);
  const to = packOf(variantPack);
  return roundMoney(from > 1 && to > 0 ? (value * to) / from : value);
}

/** Tier `tier`'s effective family price on the variant's pack. */
function familyValue(family: FamilyLadderRow, tier: number, variant: FamilyLadderRow): number {
  return familyPriceOnPack(getTierPrice(family, tier), family.unitsPerBox, variant.unitsPerBox);
}

export interface FamilyCell {
  /** What a blank box takes from the family. Null: Retail with no usable family Retail, or a blank family tier. */
  value: number | null;
  /** The variant's cell is at the family's price now. A tier follows only while Retail does. */
  follows: boolean;
}

/** The variant's five cells against its family, Retail first; null when it doesn't follow a family at all. */
export function familyCellsFor(
  family: FamilyLadderRow,
  variant: VariantLadderRow,
): FamilyCell[] | null {
  if (variant.ownOrderUnit) return null;
  const canFollow = usable(family);
  const retailFollows =
    canFollow && roundMoney(getTierPrice(variant, 1)) === familyValue(family, 1, variant);
  return [1, 2, 3, 4, 5].map((tier) => ({
    value:
      !canFollow || (tier > 1 && stored(family, tier) <= 0)
        ? null
        : familyValue(family, tier, variant),
    follows:
      retailFollows &&
      (tier === 1 ||
        roundMoney(getTierPrice(variant, tier)) === familyValue(family, tier, variant)),
  }));
}

export interface FamilyMove {
  /** The columns to write. A null tier is blank; the caller stores it by the business's blank-tier rule. */
  columns: Partial<Record<TierField, number | null>>;
  /** The Retail the variant holds now and would hold after. */
  from: number;
  to: number;
  /** `packAuto` after the move: a tier that takes a number is no longer Auto. */
  packAuto: number;
}

/**
 * What a family save from `before` to `after` would write on `variant`, or null when no cell would move. Retail matches
 * first, then each tier that also matches. A variant with a different Retail, an order unit of its own, or a family with
 * no usable Retail on either side is never on the list.
 */
export function familyMoveOf(
  before: FamilyLadderRow,
  after: FamilyLadderRow,
  variant: VariantLadderRow,
): FamilyMove | null {
  const cells = familyCellsFor(before, variant);
  if (!cells?.[0]?.follows || !usable(after)) return null;
  const toRetail = familyValue(after, 1, variant);
  const columns: FamilyMove["columns"] = {};
  let packAuto = Math.trunc(Number(variant.packAuto)) || 0;
  [1, 2, 3, 4, 5].forEach((tier) => {
    if (!cells[tier - 1]?.follows) return;
    const field = TIER_FIELDS[tier - 1] as TierField;
    const blankNow = stored(variant, tier) <= 0;
    if (tier === 1) {
      if (toRetail !== roundMoney(getTierPrice(variant, 1))) columns[field] = toRetail;
    } else if (stored(after, tier) <= 0) {
      if (!blankNow) columns[field] = null;
    } else {
      const to = familyValue(after, tier, variant);
      // A blank tier already bills the new Retail, so it stays blank rather than turning into a typed copy.
      if (blankNow ? to !== toRetail : to !== roundMoney(stored(variant, tier))) {
        columns[field] = to;
        packAuto &= ~(1 << (tier - 1));
      }
    }
  });
  if (Object.keys(columns).length === 0) return null;
  return { columns, from: roundMoney(getTierPrice(variant, 1)), to: toRetail, packAuto };
}

export interface FamilyCellEdit {
  tier: number;
  to: number | null;
}

/**
 * What a save on a variant's own five cells means. A blank box takes the family's number while the variant follows the
 * family's Retail; under an own Retail it stays blank, so it reads Auto. A Retail typed away from the family's takes the
 * tiers still at the family's value with it, unless the same save typed them. A blank Retail with no usable family
 * Retail stays blank here, and the ladder refuses it with its own sentence.
 */
export function resolveFamilyCellEdits(
  cells: readonly FamilyCell[],
  edits: readonly FamilyCellEdit[],
): FamilyCellEdit[] {
  const retailCell = cells[0] as FamilyCell;
  const typedRetail = edits.find((e) => e.tier === 1);
  const retailTo = typedRetail
    ? typedRetail.to == null
      ? retailCell.value
      : typedRetail.to
    : undefined;
  const followsAfter = typedRetail
    ? retailTo != null && retailTo === retailCell.value
    : retailCell.follows;
  const out = edits.map((e): FamilyCellEdit => {
    if (e.to != null) return e;
    if (e.tier === 1) return { tier: 1, to: retailCell.value };
    return { tier: e.tier, to: followsAfter ? (cells[e.tier - 1]?.value ?? null) : null };
  });
  if (typedRetail && !followsAfter) {
    for (const tier of [2, 3, 4, 5]) {
      if (cells[tier - 1]?.follows && !edits.some((e) => e.tier === tier)) {
        out.push({ tier, to: null });
      }
    }
  }
  return out;
}
