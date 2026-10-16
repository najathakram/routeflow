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
  /** The unit whose Retail anchors every Auto price. Always the pack until S1b. */
  anchor: UnitRef;
}

const unitRef = (u: LadderViewUnit): UnitRef => u.id ?? `label:${u.label}`;

/**
 * The grid for one product. A unit row is included only when its label resolves to it (the pack wins its own
 * label; a duplicate label is not reachable), exactly the rows `resolveUnitPrice` can price. The base unit is
 * implicit (all Auto) when the pack holds more than one piece and no row names it.
 */
export function buildLadderView(
  product: LadderProduct,
  units: readonly LadderViewUnit[],
): LadderView {
  const packFactor = packFactorOf(product);
  const rows: LadderRow[] = [
    {
      ref: "pack",
      label: packLabelOf(product),
      factor: packFactor,
      kind: "pack",
      set: [
        Number(product.pricePerUnit) || 0, // P1: the anchor's Retail is always set
        explicitPrice(product.priceTier2),
        explicitPrice(product.priceTier3),
        explicitPrice(product.priceTier4),
        explicitPrice(product.priceTier5),
      ],
    },
  ];
  for (const u of units) {
    let level;
    try {
      level = resolveLadderLevel(product, units, u.label);
    } catch {
      continue;
    }
    if (level.row !== u) continue;
    rows.push({
      ref: unitRef(u),
      label: u.label,
      factor: u.factorToBase,
      kind: level.kind === "piece" ? "base" : "unit",
      set: [u.price, u.priceTier2, u.priceTier3, u.priceTier4, u.priceTier5].map(explicitPrice),
    });
  }
  const base = resolveLadderLevel(product, units, baseLabelOf(product));
  if (base.row === null && packFactor > 1) {
    rows.push({
      ref: "base",
      label: baseLabelOf(product),
      factor: 1,
      kind: "base",
      set: [null, null, null, null, null],
    });
  }
  return { rows: rows.sort((a, b) => b.factor - a.factor), anchor: "pack" };
}

/** The ref a unit label resolves to on this product (what `resolveUnitPrice` would price). Throws like it for an unknown label. */
export function refForLabel(
  product: LadderProduct,
  units: readonly LadderViewUnit[],
  label?: string | null,
): UnitRef {
  const level = resolveLadderLevel(product, units, label);
  if (level.kind === "pack") return "pack";
  if (level.row) return unitRef(level.row as LadderViewUnit);
  return packFactorOf(product) > 1 ? "base" : "pack"; // a one-piece pack IS the base
}

/** "set" when the cell holds a typed price, "auto" when the rules work it out. The only reader of the encoding. */
export function priceSource(row: Pick<LadderRow, "set">, tier: PriceTier): "set" | "auto" {
  return row.set[tier - 1] == null ? "auto" : "set";
}

const rowOf = (view: LadderView, ref: UnitRef): LadderRow => {
  const row = view.rows.find((r) => r.ref === ref);
  if (!row) throw new Error(`Unknown unit "${ref}" in this ladder`);
  return row;
};

/** The anchor's price at `tier`, unrounded (P1, P2). */
function anchorTier(anchor: LadderRow, tier: PriceTier, rules: TierRules): number {
  const retail = anchor.set[0] ?? 0;
  if (tier === 1) return retail;
  return anchor.set[tier - 1] ?? retail * (1 - rule(rules, tier));
}

/** One cell's price, UNROUNDED. Written in master's closed forms so rules at 0% change no bit of any result. */
export function ladderPriceExact(
  view: LadderView,
  ref: UnitRef,
  tier: PriceTier,
  rules: TierRules = DEFAULT_TIER_RULES,
): number {
  const anchor = rowOf(view, view.anchor);
  const u = rowOf(view, ref);
  const own = u.set[tier - 1];
  if (own != null) return own; // a set price is never moved
  const aRetail = anchor.set[0] ?? 0;
  if (u === anchor) return anchorTier(anchor, tier, rules); // P2
  const aTier = anchorTier(anchor, tier, rules);
  const ownRetail = u.set[0];
  if (ownRetail != null) {
    // P4 with a set Retail: the anchor's tier discount applied to this unit's own Retail.
    return aRetail > 0 ? (ownRetail * aTier) / aRetail : ownRetail;
  }
  return (aTier * u.factor) / anchor.factor; // P3 (tier 1) and P4 (tiers 2-5) with an Auto Retail
}

/** One cell's price in cents: `roundMoney` once, at the end. */
export function ladderPrice(
  view: LadderView,
  ref: UnitRef,
  tier: PriceTier,
  rules: TierRules = DEFAULT_TIER_RULES,
): number {
  return roundMoney(ladderPriceExact(view, ref, tier, rules));
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
