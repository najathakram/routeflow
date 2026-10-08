import { computeLineSubtotal, normalizeBoxesPieces, roundMoney } from "./pricing";
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

/** Thrown for a tier that is not an integer 1..5 — callers map it to a 400. */
export class InvalidTierError extends Error {
  constructor(readonly tier: unknown) {
    super(`Invalid price tier "${String(tier)}" (expected an integer 1-5)`);
    this.name = "InvalidTierError";
  }
}

/** `Number()` at the boundary, then strict: blank/NaN/fractional/out-of-range never become tier 1. */
function toTier(raw: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = typeof raw === "string" && raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new InvalidTierError(raw);
  return n as 1 | 2 | 3 | 4 | 5;
}

export const PIECE_LABEL = "Piece";

export interface LadderProduct {
  /** The pack's own label (Product.unit). Blank ⇒ "Box". */
  unit?: string | null;
  /** Units rebuild P0b: the tenant's name for the base unit. Blank/null ⇒ "Piece". */
  baseUnitLabel?: string | null;
  /** Units rebuild P0b: the tenant's name for the pack. Blank/null ⇒ the legacy `unit` text, else "Box". */
  packLabel?: string | null;
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

/** The base unit's name: the product's `baseUnitLabel`, else "Piece". The ONE source for it. */
export function baseLabelOf(product: Pick<LadderProduct, "baseUnitLabel">): string {
  return (product.baseUnitLabel ?? "").trim() || PIECE_LABEL;
}

/** The pack's name: `packLabel`, else the legacy `unit` text, else "Box". */
export function packLabelOf(product: Pick<LadderProduct, "packLabel" | "unit">): string {
  return (product.packLabel ?? "").trim() || (product.unit ?? "").trim() || "Box";
}

/** Does `label` name the pack? By `packLabel` OR the legacy unit text (either spelling sells the pack). */
function namesPack(product: LadderProduct, label: string): boolean {
  const l = norm(label);
  return (
    l === norm(packLabelOf(product)) || (!!(product.unit ?? "").trim() && l === norm(product.unit!))
  );
}

/** Does `label` name the base? The tenant's base label OR legacy "Piece". */
function namesBase(product: LadderProduct, label: string): boolean {
  const l = norm(label);
  return l === norm(baseLabelOf(product)) || l === norm(PIECE_LABEL);
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
  if (namesBase(product, label)) {
    const row = validRows(units).find((u) => u.factorToBase === 1 && namesBase(product, u.label));
    return { label: baseLabelOf(product), factorToBase: 1, kind: "piece", row: row ?? null };
  }
  if (namesPack(product, label)) return { ...pack, row: null };
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
 * #2784: the ONE resolver for "the default selling unit" — the label of the first valid level flagged
 * `isDefaultSelling`, or null (the pack is the default). A flagged row the ladder would not sell (a corrupt factor, or a
 * label the pack's own label shadows) is never the default, so a line is never held on a unit nobody can see. The picker
 * tap, the scan and a buyer's plain qty all call this (web `defaultUnitValue` and `resolveLineUnits` delegate here).
 */
export function defaultSellingLabel(
  product: LadderProduct,
  units: readonly LadderUnit[],
): string | null {
  for (const row of validRows(units)) {
    if (!row.isDefaultSelling) continue;
    // resolveLadderLevel applies the shadowing rules (the pack wins its own label; "Piece" is factor 1).
    const level = resolveLadderLevel(product, units, row.label);
    // A row the ladder does not actually sell at its own factor (a "Piece" row whose factor is not 1) is not the default.
    if (level.kind !== "pack" && level.factorToBase === row.factorToBase) return row.label;
  }
  return null;
}

/**
 * Price PER ONE unit of `unitLabel` at customer tier `tierIndex` (an integer 1..5 — a numeric
 * string is accepted; anything else throws `InvalidTierError`, never silently priced as tier 1: a
 * wrong tier is a wrong price, so callers map it to a 400).
 * A level's explicit price wins; otherwise derived from the pack (see `resolveLevelPrice`); the
 * pack itself and tier fallbacks follow `getTierPrice` exactly.
 */
export function resolveUnitPrice(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel: string | null | undefined,
  tierIndex: number | string,
): number {
  const tier = toTier(tierIndex);
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
    ...validRows(units).map((u) => ({
      label: u.factorToBase === 1 ? baseLabelOf(product) : u.label,
      factorToBase: u.factorToBase,
    })),
    { label: baseLabelOf(product), factorToBase: 1 },
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

// ─── Existing lines: the snapshot fallback (units rebuild P0b) ────────────────────────────────
// An EXISTING order/invoice line snapshots its own factor (`unitsPerBox`) and price (`unitPrice`).
// If its `unitLabel` no longer names a level of the live ladder (the level was renamed or deleted),
// a rewrite must re-resolve from that snapshot — never throw `UnknownUnitError`. NEW lines keep
// refusing unknown labels (callers use `resolveLadderLevel` / `resolveUnitPrice` directly).

export interface LineSnapshot {
  unitsPerBox?: number | null;
  unitPrice?: Numeric | null;
}

/** `resolveLadderLevel` for a line that already exists: an unknown label falls back to its snapshot factor. */
export function resolveExistingLadderLevel(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel: string | null | undefined,
  snapshot?: LineSnapshot | null,
): ResolvedLadderLevel & { row: LadderUnit | null; fromSnapshot: boolean } {
  try {
    return { ...resolveLadderLevel(product, units, unitLabel), fromSnapshot: false };
  } catch (e) {
    if (!(e instanceof UnknownUnitError)) throw e;
    const factor = Math.trunc(Number(snapshot?.unitsPerBox));
    if (!Number.isFinite(factor) || factor < 1) throw e;
    return {
      label: (unitLabel ?? "").trim(),
      factorToBase: factor,
      kind: factor === 1 ? "piece" : "level",
      row: null,
      fromSnapshot: true,
    };
  }
}

/** `resolveUnitPrice` for a line that already exists: an unknown label keeps the line's own `unitPrice`. */
export function resolveExistingUnitPrice(
  product: LadderProduct,
  units: readonly LadderUnit[],
  unitLabel: string | null | undefined,
  tierIndex: number | string,
  snapshot?: LineSnapshot | null,
): number {
  try {
    return resolveUnitPrice(product, units, unitLabel, tierIndex);
  } catch (e) {
    if (!(e instanceof UnknownUnitError)) throw e;
    const price = snapshot?.unitPrice == null ? Number.NaN : Number(snapshot.unitPrice);
    if (!Number.isFinite(price) || price < 0) throw e;
    return roundMoney(price);
  }
}

// ─── SA-728: how the BASE unit bills ──────────────────────────────────────────────────────────

export interface BaseOptionInfo {
  /** The price shown/billed per ONE base unit (rounded to cents). */
  price: number;
  source: "own" | "derived";
  /** Derived price is exact to the cent (always true for an own price). */
  exact: boolean;
  /** Derived only: "1/n of $P" — n pieces per pack, P the pack's tier price. */
  fractionOf: { n: number; packPrice: number } | null;
}

function baseRow(product: LadderProduct, units: readonly LadderUnit[]): LadderUnit | null {
  return validRows(units).find((u) => u.factorToBase === 1 && namesBase(product, u.label)) ?? null;
}

/** Does the base have its OWN price for this customer tier (a tier price, or a tier-1 price it scales)? */
function baseIsOwnPriced(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tier: 1 | 2 | 3 | 4 | 5,
): boolean {
  const row = baseRow(product, units);
  if (!row) return false;
  const tierPrices = [row.price, row.priceTier2, row.priceTier3, row.priceTier4, row.priceTier5];
  return explicitPrice(tierPrices[tier - 1]) != null || explicitPrice(row.price) != null;
}

export function describeBaseOption(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tierIndex: number | string,
): BaseOptionInfo {
  const tier = toTier(tierIndex);
  const price = resolveUnitPrice(product, units, baseLabelOf(product), tier);
  if (baseIsOwnPriced(product, units, tier)) {
    return { price, source: "own", exact: true, fractionOf: null };
  }
  const n = packFactorOf(product);
  const packPrice = roundMoney(getTierPrice(product, tier));
  const exactCents = (packPrice * 100) / n;
  const exact = Math.abs(exactCents - Math.round(exactCents)) < 1e-9;
  return { price, source: "derived", exact, fractionOf: { n, packPrice } };
}

export type BaseBilling =
  | { mode: "unit"; unitLabel: string; unitPrice: number; qty: number; subtotal: number }
  | {
      mode: "pack";
      /** null/null on a product with no pack size (the product itself is the base). */
      boxes: number | null;
      pieces: number | null;
      qty: number;
      /** The PACK's price at the tier — what computeLineSubtotal prorates. */
      packUnitPrice: number;
      subtotal: number;
    };

/**
 * How `pieces` base units bill. An OWN-priced base is a unit line {unitLabel, unitPrice =
 * resolveUnitPrice}; a DERIVED base is the pack line's pieces, prorated by `computeLineSubtotal` —
 * never `qty x` a rounded per-piece price (3-pack @ $10: 2 pcs = $6.67, not 2 x $3.33).
 */
export function planBaseBilling(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tierIndex: number | string,
  pieces: number,
): BaseBilling {
  const tier = toTier(tierIndex);
  const n = Math.trunc(Number(pieces));
  const count = Number.isFinite(n) && n > 0 ? n : 0;
  const unitLabel = baseLabelOf(product);
  if (baseIsOwnPriced(product, units, tier)) {
    const unitPrice = resolveUnitPrice(product, units, unitLabel, tier);
    return {
      mode: "unit",
      unitLabel,
      unitPrice,
      qty: count,
      subtotal: roundMoney(unitPrice * count),
    };
  }
  const upb = packFactorOf(product);
  const packUnitPrice = roundMoney(getTierPrice(product, tier));
  if (upb <= 1) {
    return {
      mode: "pack",
      boxes: null,
      pieces: null,
      qty: count,
      packUnitPrice,
      subtotal: roundMoney(packUnitPrice * count),
    };
  }
  const split = normalizeBoxesPieces({ boxes: 0, pieces: count, unitsPerBox: upb });
  return {
    mode: "pack",
    boxes: split.boxes,
    pieces: split.pieces,
    qty: split.qty,
    packUnitPrice,
    subtotal: computeLineSubtotal({
      unitPrice: packUnitPrice,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: upb,
    }),
  };
}
