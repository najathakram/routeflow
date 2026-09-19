import { roundMoney } from "./pricing";
import { getTierPrice } from "./tier-pricing";

// Multi-level units (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §2. A `ProductUnit`
// row's price is either explicit (tier 1 `price` or the matching `priceTierN`)
// or derived — proportional to the pack's own tier ladder when tier 1 is
// explicit, else a straight factor ratio off the pack. One rounding, at the end.

export interface ResolveUnitPriceLevel {
  factorToBase: number;
  price: number | null;
  priceTier2: number | null;
  priceTier3: number | null;
  priceTier4: number | null;
  priceTier5: number | null;
}

export interface ResolveLevelPriceInput {
  /** The pack's tier-1 price (Product.pricePerUnit). */
  packPrice: number;
  /** Pieces per pack (Product.unitsPerBox). */
  packFactor: number;
  /** The pack's own price AT the requested tier (== packPrice when tier === 1). */
  tierPackPrice: number;
  level: ResolveUnitPriceLevel;
  tier: 1 | 2 | 3 | 4 | 5;
}

/** Price for ONE resolved level at a given customer tier (the low-level rule). */
export function resolveLevelPrice(input: ResolveLevelPriceInput): number {
  const { packPrice, packFactor, tierPackPrice, level, tier } = input;
  const explicit =
    tier === 1
      ? level.price
      : tier === 2
        ? level.priceTier2
        : tier === 3
          ? level.priceTier3
          : tier === 4
            ? level.priceTier4
            : level.priceTier5;
  if (explicit != null) return roundMoney(explicit);
  if (level.price != null) return roundMoney((level.price * tierPackPrice) / packPrice);
  return roundMoney((tierPackPrice * level.factorToBase) / packFactor);
}

// ─── The ladder (units_v1, step 1) ────────────────────────────────────────────
// A product's ladder = its pack (`unitsPerBox`, `pricePerUnit` + tiers) + zero or more
// `ProductUnit` rows + an implicit Piece (factor 1). The SERVER resolves a line's factor
// from this ladder by label — a client-supplied factor is never trusted (B13 posture).

export const PIECE_LABEL = "Piece";

export interface LadderProduct {
  /** The pack's own label (Product.unit). Blank ⇒ "Box". */
  unit?: string | null;
  unitsPerBox?: number | null;
  pricePerUnit: number | string;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

export interface LadderUnit extends ResolveUnitPriceLevel {
  label: string;
  isDefaultSelling?: boolean;
}

export type LadderLevelKind = "pack" | "piece" | "level";

export interface ResolvedLadderLevel {
  label: string;
  factorToBase: number;
  kind: LadderLevelKind;
}

/** Thrown for a label the product's ladder does not define — callers map it to a 400. */
export class UnknownUnitError extends Error {
  constructor(readonly unitLabel: string) {
    super(`Unknown unit "${unitLabel}" for this product`);
    this.name = "UnknownUnitError";
  }
}

const norm = (s: string) => s.trim().toLowerCase();
const noLevel = {
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};

function packFactorOf(product: LadderProduct): number {
  const upb = Math.trunc(Number(product.unitsPerBox ?? 0));
  return upb > 1 ? upb : 1;
}

function packLabelOf(product: LadderProduct): string {
  return (product.unit ?? "").trim() || "Box";
}

/** Exact label first, then case-insensitive — "Case" and "case" may both exist on one product. */
function findUnitRow(units: readonly LadderUnit[], label: string): LadderUnit | undefined {
  const exact = units.find((u) => u.label === label);
  return exact ?? units.find((u) => norm(u.label) === norm(label));
}

/**
 * Resolve `unitLabel` against the ladder. Absent/blank ⇒ the pack (today's behaviour, byte for
 * byte). Order: a `ProductUnit` row → the pack's own label → "Piece" → UnknownUnitError.
 */
export function resolveLadderLevel(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel?: string | null,
): ResolvedLadderLevel & { row: LadderUnit | null } {
  const label = (unitLabel ?? "").trim();
  const packFactor = packFactorOf(product);
  const pack = { label: packLabelOf(product), factorToBase: packFactor, kind: "pack" as const };
  if (!label) return { ...pack, row: null };
  const row = findUnitRow(units, label);
  if (row) {
    const kind = row.factorToBase === 1 ? "piece" : "level";
    return { label: row.label, factorToBase: row.factorToBase, kind, row };
  }
  if (norm(label) === norm(pack.label)) return { ...pack, row: null };
  if (norm(label) === norm(PIECE_LABEL)) {
    return { label: PIECE_LABEL, factorToBase: 1, kind: "piece", row: null };
  }
  throw new UnknownUnitError(label);
}

/**
 * Price PER ONE unit of `unitLabel` at customer tier `tierIndex` (1..5; anything else ⇒ 1).
 * A level's explicit price wins; otherwise derived from the pack (see `resolveLevelPrice`); the
 * pack itself and tier fallbacks follow `getTierPrice` exactly.
 */
export function resolveUnitPrice(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel: string | null | undefined,
  tierIndex: number,
): number {
  const tier = ([1, 2, 3, 4, 5].includes(tierIndex) ? tierIndex : 1) as 1 | 2 | 3 | 4 | 5;
  const tierPackPrice = getTierPrice(product, tier);
  const level = resolveLadderLevel(product, units, unitLabel);
  if (level.kind === "pack") return roundMoney(tierPackPrice);
  return resolveLevelPrice({
    packPrice: getTierPrice(product, 1),
    packFactor: packFactorOf(product),
    tierPackPrice,
    level: level.row ?? { ...noLevel, factorToBase: level.factorToBase },
    tier,
  });
}

/** Whole `qty` of a level → base pieces. Always a non-negative integer. */
export function toBaseQty(qty: number, factorToBase: number): number {
  const q = Math.trunc(Number(qty));
  const f = Math.trunc(Number(factorToBase));
  return Number.isFinite(q) && Number.isFinite(f) && q > 0 && f > 0 ? q * f : 0;
}

export interface BaseQtyPart {
  label: string;
  factorToBase: number;
  qty: number;
}

/**
 * Split a base-piece quantity across the ladder, largest level first (pack included, implicit
 * Piece appended). The remainder always lands on the last (smallest) level — nothing is ever
 * dropped: Σ part.qty × part.factorToBase === baseQty. Zero-qty parts are omitted.
 */
export function fromBaseQty(
  baseQty: number,
  product: LadderProduct,
  units: readonly LadderUnit[],
): BaseQtyPart[] {
  let rest = Math.max(0, Math.trunc(Number(baseQty)) || 0);
  const levels: Array<{ label: string; factorToBase: number }> = [
    ...units.map((u) => ({ label: u.label, factorToBase: u.factorToBase })),
    { label: packLabelOf(product), factorToBase: packFactorOf(product) },
    { label: PIECE_LABEL, factorToBase: 1 },
  ]
    .filter(
      (l, i, all) =>
        l.factorToBase >= 1 && all.findIndex((x) => x.factorToBase === l.factorToBase) === i,
    )
    .sort((a, b) => b.factorToBase - a.factorToBase);
  const parts: BaseQtyPart[] = [];
  for (const l of levels) {
    const qty = Math.floor(rest / l.factorToBase);
    if (qty > 0) parts.push({ ...l, qty });
    rest -= qty * l.factorToBase;
  }
  return parts;
}
