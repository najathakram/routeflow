import { roundMoney } from "./pricing";
import { getTierPrice } from "./tier-pricing";

// Multi-level units (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §2. A `ProductUnit`
// row's price is either explicit (tier 1 `price` or the matching `priceTierN`)
// or derived — proportional to the pack's own tier ladder when tier 1 is
// explicit, else a straight factor ratio off the pack. One rounding, at the end.

/** A money/qty value as it arrives from Prisma: number, string, or a `Decimal` (valueOf → string). */
export type Numeric = number | string | { valueOf(): number | string };

export interface ResolveUnitPriceLevel {
  factorToBase: number;
  price: Numeric | null;
  priceTier2: Numeric | null;
  priceTier3: Numeric | null;
  priceTier4: Numeric | null;
  priceTier5: Numeric | null;
}

/**
 * A level price counts as EXPLICIT only when it is a positive number — the same convention as
 * `getTierPrice`'s `|| fallback` (and `cascadeTierPrices`, which writes "0.00" to mean "inherit
 * again"). NULL, 0, NaN and negatives are all "derive". Coerces Decimal/string so an operator's
 * typed price can never silently round to 0.00.
 */
function explicitPrice(v: Numeric | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  const tierPrices = [
    level.price,
    level.priceTier2,
    level.priceTier3,
    level.priceTier4,
    level.priceTier5,
  ];
  const explicit = explicitPrice(tierPrices[tier - 1]);
  if (explicit != null) return roundMoney(explicit);
  const base = explicitPrice(level.price);
  // A zero pack price gives no ladder to scale by — the level's own price stands unscaled.
  if (base != null) return roundMoney(packPrice > 0 ? (base * tierPackPrice) / packPrice : base);
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

/** Only rows with a positive integer factor can be sold — a corrupt row is invisible, never priced. */
const validRows = (units: readonly LadderUnit[]) =>
  units.filter((u) => Number.isInteger(u.factorToBase) && u.factorToBase >= 1);

/** Exact label first, then case-insensitive — "Case" and "case" may both exist on one product. */
function findUnitRow(units: readonly LadderUnit[], label: string): LadderUnit | undefined {
  const rows = validRows(units);
  return rows.find((u) => u.label === label) ?? rows.find((u) => norm(u.label) === norm(label));
}

/**
 * Resolve `unitLabel` against the ladder. Absent/blank ⇒ the pack (today's behaviour, byte for
 * byte). Order: "Piece" (always factor 1, even if the pack itself is labelled "Piece") → the
 * pack's own label (the pack wins over a colliding row) → a `ProductUnit` row → UnknownUnitError.
 */
export function resolveLadderLevel(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel?: string | null,
): ResolvedLadderLevel & { row: LadderUnit | null } {
  const label = (unitLabel ?? "").trim();
  const pack = {
    label: packLabelOf(product),
    factorToBase: packFactorOf(product),
    kind: "pack" as const,
  };
  if (!label) return { ...pack, row: null };
  if (norm(label) === norm(PIECE_LABEL)) {
    const row = validRows(units).find(
      (u) => u.factorToBase === 1 && norm(u.label) === norm(PIECE_LABEL),
    );
    return { label: PIECE_LABEL, factorToBase: 1, kind: "piece", row: row ?? null };
  }
  if (norm(label) === norm(pack.label)) return { ...pack, row: null };
  const row = findUnitRow(units, label);
  if (!row) throw new UnknownUnitError(label);
  return {
    label: row.label,
    factorToBase: row.factorToBase,
    kind: row.factorToBase === 1 ? "piece" : "level",
    row,
  };
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
  const n = Math.trunc(Number(baseQty));
  let rest = Number.isFinite(n) ? Math.max(0, n) : 0;
  // Pack first so it survives the by-factor dedupe over a row sharing its factor; rows before
  // the implicit Piece so an explicit Piece row keeps its label.
  const levels: Array<{ label: string; factorToBase: number }> = [
    { label: packLabelOf(product), factorToBase: packFactorOf(product) },
    ...validRows(units).map((u) => ({ label: u.label, factorToBase: u.factorToBase })),
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
