import { roundMoney } from "./pricing";
import type { CellChange } from "./price-anchor";
import {
  DEFAULT_TIER_RULES,
  PRICE_TIERS,
  ladderPrice,
  priceSource,
  rowOf,
  validateSetPrice,
  type LadderView,
  type PriceTier,
  type TierRules,
  type UnitRef,
} from "./price-ladder";

// Units and prices, pricing core B (PLAN product-units-pricing §1.4, owner requirement 9): change prices by an amount or a
// percentage, with the option to move the other units to match, an undo patch, and a one-click offer when a typed
// price ends up under the tiers below it. Pure functions over a LadderView: they return cell patches, the server
// re-checks (above $0.00, whole cents) and writes once.

/** The one rounding for a proportional move: roundMoney(from x num / den). Percent change and web's cascade both use it. */
export function scalePrice(from: number, num: number, den: number): number {
  return roundMoney((from * num) / den);
}

/** A set price to write: a number, or null = clear the cell (Auto again). */
export interface CellPatch {
  ref: UnitRef;
  tier: PriceTier;
  to: number | null;
}

/** Apply patches to a view and return the patches that undo them (each cell's previous set value, or null for Auto). */
export function applyCellPatches(
  view: LadderView,
  patches: readonly CellPatch[],
): { view: LadderView; undo: CellPatch[] } {
  const undo: CellPatch[] = [];
  let rows = view.rows;
  for (const p of patches) {
    const before = rowOf({ ...view, rows }, p.ref).set[p.tier - 1];
    undo.unshift({ ref: p.ref, tier: p.tier, to: before });
    rows = rows.map((r) =>
      r.ref === p.ref ? { ...r, set: r.set.map((v, i) => (i === p.tier - 1 ? p.to : v)) } : r,
    );
  }
  return { view: { ...view, rows }, undo };
}

export interface InversionOffer {
  /** The unit and the typed cell that sit under the Auto tiers below. */
  ref: UnitRef;
  tier: PriceTier;
  /** The Auto tiers that are now higher than the typed price. */
  tiers: PriceTier[];
  value: number;
  warning: string;
  title: string;
  /** One click: set those tiers to the typed price. */
  patches: CellPatch[];
}

const defaultTierName = (t: PriceTier): string => (t === 1 ? "Retail" : `Tier ${t}`);
const joinNames = (names: string[]): string =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const dollars = (n: number): string => `$${n.toFixed(2)}`;

/**
 * "A typed tier ends up below an Auto tier after it": for each touched Set cell, the Auto tiers that follow it (up to the
 * next Set tier, the owner's own choice) and now cost MORE than it. Never written silently: the caller shows the warning and
 * the title as a one-click button. With `prior` (the grid before the edit), a tier that was ALREADY under the cell's old price
 * is not offered again, so a bulk change stays quiet about inversions the owner already had.
 */
export function inversionOffers(
  view: LadderView,
  touched: readonly { ref: UnitRef; tier: PriceTier }[],
  rules: TierRules = DEFAULT_TIER_RULES,
  tierName: (t: PriceTier) => string = defaultTierName,
  prior?: LadderView,
): InversionOffer[] {
  const offers: InversionOffer[] = [];
  for (const t of touched) {
    const row = rowOf(view, t.ref);
    const value = row.set[t.tier - 1];
    if (value == null) continue;
    const tiers: PriceTier[] = [];
    for (let s = t.tier + 1; s <= 5; s++) {
      const tier = s as PriceTier;
      if (priceSource(row, tier) === "set") break;
      if (ladderPrice(view, t.ref, tier, rules) <= value) continue;
      const before = prior?.rows.find((r) => r.ref === t.ref);
      const wasInverted =
        before != null &&
        priceSource(before, tier) === "auto" &&
        ladderPrice(prior!, t.ref, tier, rules) > ladderPrice(prior!, t.ref, t.tier, rules);
      if (!wasInverted) tiers.push(tier);
    }
    if (tiers.length === 0) continue;
    const names = joinNames(tiers.map(tierName));
    offers.push({
      ref: t.ref,
      tier: t.tier,
      tiers,
      value,
      warning: `${names} ${tiers.length > 1 ? "are" : "is"} higher than ${tierName(t.tier)} (${dollars(value)}).`,
      title: `Set ${names} to ${dollars(value)} too`,
      patches: tiers.map((tier) => ({ ref: t.ref, tier, to: value })),
    });
  }
  return offers;
}

export interface CellEditPlan {
  patches: CellPatch[];
  undo: CellPatch[];
  offers: InversionOffer[];
  problems: string[];
  view: LadderView;
}

/**
 * Typing into one cell sets THAT cell only (no copy-down). Blank clears it (Auto again); zero or junk is refused (P6). The
 * unit the other prices are worked out from cannot lose its Retail (P1). Tiers under the typed price come back as an offer.
 */
export function planCellEdit(
  view: LadderView,
  ref: UnitRef,
  tier: PriceTier,
  typed: unknown,
  rules: TierRules = DEFAULT_TIER_RULES,
  tierName?: (t: PriceTier) => string,
): CellEditPlan {
  const refuse = (message: string): CellEditPlan => ({
    patches: [],
    undo: [],
    offers: [],
    problems: [message],
    view,
  });
  const row = view.rows.find((r) => r.ref === ref);
  if (!row) return refuse("That unit is not on this product.");
  const checked = validateSetPrice(typed);
  if (!checked.ok) return refuse(checked.message);
  if (checked.value == null && ref === view.anchor && tier === 1) {
    return refuse(
      `${row.label} is the unit the other prices are worked out from, so it needs a price.`,
    );
  }
  const patches: CellPatch[] = [{ ref, tier, to: checked.value }];
  const applied = applyCellPatches(view, patches);
  return {
    patches,
    undo: applied.undo,
    offers: inversionOffers(applied.view, [{ ref, tier }], rules, tierName),
    problems: [],
    view: applied.view,
  };
}

export interface PriceChange {
  /** The unit being changed; its Retail always moves. */
  unit: UnitRef;
  direction: "raise" | "lower";
  /** "percent": each moved price x (1 +/- p). "amount": the picked unit +/- a, the others +/- a x pieces(U) / pieces(picked). */
  mode: "percent" | "amount";
  value: number;
  /** Also move every SET price of every unit and tier (Auto prices follow by the rules). Off by default. */
  also?: boolean;
}

export interface PriceChangePlan {
  patches: CellPatch[];
  undo: CellPatch[];
  /** Every price, set or Auto, that differs after the change, old to new. */
  changes: CellChange[];
  offers: InversionOffer[];
  problems: string[];
  view: LadderView;
}

/**
 * Plan a price change (owner requirement 9). Moved prices: the picked unit's Retail, and with `also` every Set price of every
 * unit and tier. One rounding per price. A change that would take any price to $0.00 or less writes nothing.
 */
export function planPriceChange(
  view: LadderView,
  change: PriceChange,
  rules: TierRules = DEFAULT_TIER_RULES,
  tierName?: (t: PriceTier) => string,
): PriceChangePlan {
  const refuse = (message: string): PriceChangePlan => ({
    patches: [],
    undo: [],
    changes: [],
    offers: [],
    problems: [message],
    view,
  });
  const picked = view.rows.find((r) => r.ref === change.unit);
  if (!picked) return refuse("That unit is not on this product.");
  const value = change.value;
  if (!Number.isFinite(value) || value <= 0) return refuse("Enter an amount above zero.");
  const sign = change.direction === "raise" ? 1 : -1;
  const moved = new Map<
    string,
    { ref: UnitRef; tier: PriceTier; factor: number; from: number; label: string }
  >();
  const add = (ref: UnitRef, tier: PriceTier, factor: number, label: string, from: number) =>
    moved.set(`${ref}|${tier}`, { ref, tier, factor, from, label });
  add(picked.ref, 1, picked.factor, picked.label, ladderPrice(view, picked.ref, 1, rules));
  if (change.also) {
    for (const row of view.rows) {
      for (const tier of PRICE_TIERS) {
        const set = row.set[tier - 1];
        if (set != null) add(row.ref, tier, row.factor, row.label, set);
      }
    }
  }
  const patches: CellPatch[] = [];
  for (const m of moved.values()) {
    const to =
      change.mode === "percent"
        ? scalePrice(m.from, 100 + sign * value, 100)
        : roundMoney(m.from + (sign * value * m.factor) / picked.factor);
    if (!(to > 0)) {
      return refuse(`${m.label} would go to $0.00 or less. Use a smaller change.`);
    }
    if (to !== m.from || priceSource(rowOf(view, m.ref), m.tier) === "auto") {
      patches.push({ ref: m.ref, tier: m.tier, to });
    }
  }
  const applied = applyCellPatches(view, patches);
  const changes: CellChange[] = [];
  for (const row of view.rows) {
    for (const tier of PRICE_TIERS) {
      const before = ladderPrice(view, row.ref, tier, rules);
      const after = ladderPrice(applied.view, row.ref, tier, rules);
      if (before !== after)
        changes.push({ ref: row.ref, label: row.label, tier, from: before, to: after });
    }
  }
  return {
    patches,
    undo: applied.undo,
    changes,
    offers: inversionOffers(
      applied.view,
      patches.map((p) => ({ ref: p.ref, tier: p.tier })),
      rules,
      tierName,
      view,
    ),
    problems: [],
    view: applied.view,
  };
}
