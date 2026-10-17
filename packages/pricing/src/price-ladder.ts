import { roundMoney } from "./pricing";
import {
  baseLabelOf,
  explicitPrice,
  packFactorOf,
  packLabelOf,
  resolveLadderLevel,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

// Units and prices, pricing core A (PLAN product-units-pricing §1.3, rules P1-P6).
//
// ONE read model of a product's price grid: rows = units (largest first), columns = Retail + tiers 2-5.
// A cell is Set (a positive number somebody typed) or Auto (worked out by the rules below). Nothing here
// writes anything and nothing is rounded until the last step: `roundMoney` runs ONCE per price, so with
// the tier rules at their 0% default every value equals what `resolveUnitPrice` returns today (pinned by
// price-ladder.spec.ts against the committed master golden file and a generated-ladder property test).
//
// Rules, with the PACK as the anchor (S1b makes the anchor an order unit per scope):
//   P1  the anchor's Retail is always set (the grid offers no Auto for it).
//   P2  anchor Tier N: set, else anchor Retail x (1 - r_N). r_N is the business tier rule, default 0.
//   P3  other unit's Retail: set, else anchor Retail x pieces(U) / pieces(anchor).
//   P4  other unit's Tier N: set, else the unit's Retail x anchor Tier N / anchor Retail
//       (the anchor's tier discount; written in the closed forms master uses, so 0% is byte-identical).
//   P6  a set price must be above $0.00 (validateSetPrice); clearing a cell makes it Auto again.

export type PriceTier = 1 | 2 | 3 | 4 | 5;
export const PRICE_TIERS: readonly PriceTier[] = [1, 2, 3, 4, 5];

/** A unit's identity in the view: "pack", "base", or the ProductUnit id (label based when it has none). */
export type UnitRef = string;

/** Business tier rules: percent BELOW Retail for tier 2..5. A missing tier is 0% (Auto = Retail). */
export type TierRules = Partial<Record<2 | 3 | 4 | 5, number>>;
export const DEFAULT_TIER_RULES: Readonly<TierRules> = Object.freeze({});

/** Stored settings JSON to rules. Safe on any value: only finite percents in [0, 100) for tiers 2-5 survive. */
export function normalizeTierRules(raw: unknown): TierRules {
  const out: TierRules = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const t of [2, 3, 4, 5] as const) {
    const v = (raw as Record<string, unknown>)[String(t)];
    const n =
      typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0 && n < 100) out[t] = n;
  }
  return out;
}

/** r_N as a fraction (0.08 for 8%). Anything that is not a percent in [0, 100) is 0. */
const rule = (rules: TierRules, tier: PriceTier): number => {
  const p = tier === 1 ? 0 : rules[tier];
  return typeof p === "number" && Number.isFinite(p) && p > 0 && p < 100 ? p / 100 : 0;
};

export interface LadderViewUnit extends LadderUnit {
  /** ProductUnit.id. Without it the row is addressed by label. */
  id?: string;
}

export interface LadderRow {
  ref: UnitRef;
  label: string;
  /** Pieces in one of this unit. */
  factor: number;
  kind: "pack" | "base" | "unit";
  /** Index 0 = Retail, 1..4 = tiers 2..5. A positive number = Set; null = Auto. */
  set: readonly (number | null)[];
}

export interface LadderView {
  /** Largest unit first. */
  rows: readonly LadderRow[];
  /** The product's order unit: its Retail anchors every Auto Retail (P1, P3). The pack unless chosen. */
  anchor: UnitRef;
  /** Tier N's own order unit for this product (owner Q2b). A tier without an entry follows `anchor`. */
  tierAnchors: Readonly<Partial<Record<2 | 3 | 4 | 5, UnitRef>>>;
}

export interface LadderViewOptions {
  /** The product's order unit (a ref). A ref the ladder does not have is skipped: the pack anchors. */
  orderUnit?: UnitRef | null;
  tierOrderUnits?: Partial<Record<2 | 3 | 4 | 5, UnitRef | null>>;
  /** `Product.packAuto`: bit i set = the pack's cell i (0 = Retail, 1..4 = tiers 2..5) is Auto. Missing = 0. */
  packAuto?: number | null;
}

const unitRef = (u: LadderViewUnit): UnitRef => u.id ?? `label:${u.label}`;

/**
 * SA-809: the 1-piece level's ref names the LEVEL, not the row: "base" (a row backs it, or the pack holds more than one
 * piece), "pack" for a one-piece pack with no row. A factor-1 row at a one-piece pack is unreachable through the units
 * service; master prices its label from the row (golden file), so it stays its own "base" cell. Never a ProductUnit id.
 */
const pieceRef = (product: LadderProduct, backed: boolean): UnitRef =>
  backed || packFactorOf(product) > 1 ? "base" : "pack";

/**
 * The grid for one product. A unit row is included only when its label resolves to it (the pack wins its own
 * label; a duplicate label is not reachable), exactly the rows `resolveUnitPrice` can price. The base unit is
 * implicit (all Auto) when the pack holds more than one piece and no row names it.
 */
export function buildLadderView(
  product: LadderProduct,
  units: readonly LadderViewUnit[],
  opts: LadderViewOptions = {},
): LadderView {
  const packFactor = packFactorOf(product);
  const auto = Math.trunc(Number(opts.packAuto)) || 0;
  const bit = (i: number) => ((auto >> i) & 1) === 1;
  // A materialized pack cell (its bit is set) is Auto even though it holds a number (SA-795 P8).
  const packTier = (v: LadderProduct["priceTier2"], i: number) =>
    bit(i) ? null : explicitPrice(v);
  const rows: LadderRow[] = [
    {
      ref: "pack",
      label: packLabelOf(product),
      factor: packFactor,
      kind: "pack",
      set: [
        Number(product.pricePerUnit) || 0, // P1: the anchor's Retail is always set (see below if it is not the pack)
        packTier(product.priceTier2, 1),
        packTier(product.priceTier3, 2),
        packTier(product.priceTier4, 3),
        packTier(product.priceTier5, 4),
      ],
    },
  ];
  let hasPiece = false;
  for (const u of units) {
    let level;
    try {
      level = resolveLadderLevel(product, units, u.label);
    } catch {
      continue;
    }
    if (level.row !== u) continue;
    const piece = level.kind === "piece";
    if (piece && hasPiece) continue; // one row names the base (the units service allows one factor-1 row)
    hasPiece ||= piece;
    rows.push({
      ref: piece ? "base" : unitRef(u),
      label: u.label,
      factor: u.factorToBase,
      kind: piece ? "base" : "unit",
      set: [u.price, u.priceTier2, u.priceTier3, u.priceTier4, u.priceTier5].map(explicitPrice),
    });
  }
  if (!hasPiece && packFactor > 1) {
    rows.push({
      ref: "base",
      label: baseLabelOf(product),
      factor: 1,
      kind: "base",
      set: [null, null, null, null, null],
    });
  }
  const has = (r?: UnitRef | null): r is UnitRef => !!r && rows.some((x) => x.ref === r);
  const anchor = has(opts.orderUnit) ? opts.orderUnit : "pack";
  const anchorHasRetail = rows.some((x) => x.ref === anchor && x.set[0] != null);
  if (anchor !== "pack" && bit(0) && anchorHasRetail) {
    // The pack's Retail is a materialized number, not a typed price: Auto, worked out from the anchor. An anchor
    // with no Retail of its own (P1 broken) keeps it, as the source the other units are priced from by size.
    rows[0] = { ...rows[0], set: [null, ...rows[0].set.slice(1)] };
  }
  const tierAnchors: Partial<Record<2 | 3 | 4 | 5, UnitRef>> = {};
  for (const t of [2, 3, 4, 5] as const) {
    const r = opts.tierOrderUnits?.[t];
    if (has(r) && r !== anchor) tierAnchors[t] = r;
  }
  return { rows: rows.sort((a, b) => b.factor - a.factor), anchor, tierAnchors };
}

/** The ref a unit label resolves to on this product (what `resolveUnitPrice` would price). Throws like it for an unknown label. */
export function refForLabel(
  product: LadderProduct,
  units: readonly LadderViewUnit[],
  label?: string | null,
): UnitRef {
  const level = resolveLadderLevel(product, units, label);
  if (level.kind === "pack") return "pack";
  return level.kind === "piece"
    ? pieceRef(product, !!level.row)
    : unitRef(level.row as LadderViewUnit);
}

/**
 * SA-809: the ONE ref-write canonicalizer. A ProductUnit id (or label ref) that names the 1-piece row becomes the level's
 * ref ("base"); every other ref is returned as given. Every writer of a stored ref (the 7 R-3 columns) calls it.
 */
export function canonicalUnitRef(units: readonly LadderViewUnit[], ref: UnitRef): UnitRef {
  const row = units.find((u) => unitRef(u) === ref);
  return row && row.factorToBase === 1 ? "base" : ref;
}

/** "set" when the cell holds a typed price, "auto" when the rules work it out. The only reader of the encoding. */
export function priceSource(row: Pick<LadderRow, "set">, tier: PriceTier): "set" | "auto" {
  return row.set[tier - 1] == null ? "auto" : "set";
}

export const rowOf = (view: LadderView, ref: UnitRef): LadderRow => {
  const row = view.rows.find((r) => r.ref === ref);
  if (!row) throw new Error(`Unknown unit "${ref}" in this ladder`);
  return row;
};

/** The anchor's Retail, unrounded. P1: set. A ladder whose anchor has no typed Retail yet is read from the pack by size. */
function anchorRetail(view: LadderView): number {
  const a = rowOf(view, view.anchor);
  if (a.set[0] != null) return a.set[0];
  const pack = rowOf(view, "pack");
  return ((pack.set[0] ?? 0) * a.factor) / pack.factor;
}

/**
 * One cell's price, UNROUNDED. Retail cells follow the product's order unit A (P1, P3); tier N cells follow tier N's
 * anchor K (its own order unit, else A; P2, P4). `tierAnchor` overrides K for one call (a customer's own order unit,
 * P4c). Written in master's closed forms where K = A, so rules at 0% change no bit of any result.
 */
export function ladderPriceExact(
  view: LadderView,
  ref: UnitRef,
  tier: PriceTier,
  rules: TierRules = DEFAULT_TIER_RULES,
  tierAnchor?: UnitRef,
): number {
  const a = rowOf(view, view.anchor);
  const u = rowOf(view, ref);
  const own = u.set[tier - 1];
  if (own != null) return own; // a set price is never moved
  const aRetail = anchorRetail(view);
  const retailOf = (r: LadderRow): number =>
    r.set[0] ?? (r === a ? aRetail : (aRetail * r.factor) / a.factor);
  if (tier === 1) return retailOf(u); // P3
  const k = rowOf(view, tierAnchor ?? view.tierAnchors[tier] ?? view.anchor);
  const kRetail = retailOf(k);
  const kTier = k.set[tier - 1] ?? kRetail * (1 - rule(rules, tier)); // P2
  if (u === k) return kTier;
  if (u.set[0] != null || (k !== a && k.set[0] != null)) {
    // P4: this unit's Retail carries the anchor's tier discount.
    const uRetail = retailOf(u);
    return kRetail > 0 ? (uRetail * kTier) / kRetail : uRetail;
  }
  return (kTier * u.factor) / k.factor; // P4, both Retails Auto: the same ratio in master's closed form
}

/** One cell's price in cents: `roundMoney` once, at the end. */
export function ladderPrice(
  view: LadderView,
  ref: UnitRef,
  tier: PriceTier,
  rules: TierRules = DEFAULT_TIER_RULES,
  tierAnchor?: UnitRef,
): number {
  return roundMoney(ladderPriceExact(view, ref, tier, rules, tierAnchor));
}

export interface GridCell {
  tier: PriceTier;
  source: "set" | "auto";
  value: number;
}
export interface GridRow {
  ref: UnitRef;
  label: string;
  factor: number;
  kind: LadderRow["kind"];
  cells: GridCell[];
}

/** The whole grid, one row per unit and one cell per tier, ready for a screen. */
export function priceGrid(view: LadderView, rules: TierRules = DEFAULT_TIER_RULES): GridRow[] {
  return view.rows.map((r) => ({
    ref: r.ref,
    label: r.label,
    factor: r.factor,
    kind: r.kind,
    cells: PRICE_TIERS.map((tier) => ({
      tier,
      source: priceSource(r, tier),
      value: ladderPrice(view, r.ref, tier, rules),
    })),
  }));
}

export type SetPriceCheck = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * P6: what a typed price means. Blank clears the cell (Auto, value null). Zero, negative or unreadable is refused with a
 * message the screen can show as it is. A good price comes back rounded to cents.
 */
export function validateSetPrice(raw: unknown): SetPriceCheck {
  if (raw == null || (typeof raw === "string" && raw.trim() === ""))
    return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      message: "Enter a price like 12.50, or clear the box to use the automatic price.",
    };
  }
  const cents = roundMoney(n);
  if (cents <= 0) {
    return {
      ok: false,
      message: "A price must be above $0.00. Clear the box to use the automatic price.",
    };
  }
  return { ok: true, value: cents };
}
