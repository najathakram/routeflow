import { roundMoney } from "./pricing";
import {
  customerAnchor,
  customerPrice,
  customerPriceExact,
  type CellChange,
  type CustomerPricingWithId,
  type Pin,
} from "./price-anchor";
import {
  DEFAULT_TIER_RULES,
  PRICE_TIERS,
  ladderPrice,
  ladderPriceExact,
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
  /** The tier offer ("Also update" the same unit in the tiers below). Never ticked (SA-799 a). */
  kind: "tier";
  ticked: false;
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
      kind: "tier",
      ticked: false,
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

/** An Auto cell that moves because of the edit ("This also changes"). `keep` pins it as set at its current value (P7). */
export interface FollowerRow extends CellChange {
  keep: Pin;
}

/** One customer cell whose price moves, old to new (SA-798). `against` = it moves the other way from the change. */
export interface CustomerChange {
  customerId: string;
  ref: UnitRef;
  tier: PriceTier;
  from: number;
  to: number;
  against: boolean;
  /**
   * Meaningful only when `against` is true (a row that follows the change is always "shape"). "rounding" = only the
   * rounded price went against (the exact one did not); otherwise "shape".
   */
  cause: "shape" | "rounding";
}

/** SA-798 (c): move each customer's set cell in step with its tier. Opt-in, so `ticked` is always false. */
export interface CustomerMoveOffer {
  kind: "customer";
  ticked: false;
  title: string;
  moves: {
    customerId: string;
    ref: UnitRef;
    tier: PriceTier;
    from: number;
    to: number;
    /** SA-798a: the move goes the other way from the change; then `cause` is "shape" (a tier-ratio move, never rounding). */
    against: boolean;
    cause?: "shape";
  }[];
}

export type PriceOffer = InversionOffer | CustomerMoveOffer;

/** What both planners return (SA-799): the panel renders this one type. */
export interface PricePlan {
  patches: CellPatch[];
  undo: CellPatch[];
  /** The Auto cells that move because of the patches, each with its Keep. */
  followers: FollowerRow[];
  offers: PriceOffer[];
  customerChanges: CustomerChange[];
  /** Every price, set or Auto, that differs after the change, old to new (patched cells included). */
  changes: CellChange[];
  problems: string[];
  view: LadderView;
}
export type CellEditPlan = PricePlan;
export type PriceChangePlan = PricePlan;

const cellKey = (c: { ref: UnitRef; tier: PriceTier }): string => `${c.ref}|${c.tier}`;

function cellChanges(before: LadderView, after: LadderView, rules: TierRules): CellChange[] {
  const changes: CellChange[] = [];
  for (const row of before.rows) {
    for (const tier of PRICE_TIERS) {
      const from = ladderPrice(before, row.ref, tier, rules);
      const to = ladderPrice(after, row.ref, tier, rules);
      if (from !== to) changes.push({ ref: row.ref, label: row.label, tier, from, to });
    }
  }
  return changes;
}

const followersOf = (
  changes: readonly CellChange[],
  patches: readonly CellPatch[],
): FollowerRow[] => {
  const patched = new Set(patches.map(cellKey));
  return changes
    .filter((c) => !patched.has(cellKey(c)))
    .map((c) => ({ ...c, keep: { ref: c.ref, tier: c.tier, value: c.from } }));
};

const emptyPlan = (view: LadderView, problems: string[]): PricePlan => ({
  patches: [],
  undo: [],
  followers: [],
  offers: [],
  customerChanges: [],
  changes: [],
  problems,
  view,
});

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
  opts: PriceChangeOptions = {},
): PricePlan {
  const refuse = (message: string): PricePlan => emptyPlan(view, [message]);
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
  const changes = cellChanges(view, applied.view, rules);
  const customers = opts.customers ?? [];
  // The edit's own direction is the cell's move (no rounding step here).
  const dir =
    ladderPrice(applied.view, ref, tier, rules) >= ladderPrice(view, ref, tier, rules) ? 1 : -1;
  // F20 / SA-799: one pattern for any changed price, so a cell edit offers the same unticked customer opt-in.
  const customerOffer = customerMoveOffer(view, applied.view, customers, rules, dir);
  return {
    patches,
    undo: applied.undo,
    followers: followersOf(changes, patches),
    offers: [
      ...inversionOffers(applied.view, [{ ref, tier }], rules, tierName),
      ...(customerOffer ? [customerOffer] : []),
    ],
    // SA-799: customer changes are never hidden.
    customerChanges: planCustomerChanges(view, applied.view, applied.view, customers, rules, dir),
    changes,
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

export interface PriceChangeOptions {
  /** The customers whose prices are checked against the change (S20 owns the loader). Empty or missing = today. */
  customers?: readonly CustomerPricingWithId[];
}

/**
 * SA-798: every customer cell that moves, old to new, `against` when it goes the other way from the change. Pure,
 * O(customers x units). `cause` is "rounding" when the price worked out from the unrounded product moves did not go
 * against, but the rounded one did.
 */
function planCustomerChanges(
  before: LadderView,
  after: LadderView,
  afterUnrounded: LadderView,
  customers: readonly CustomerPricingWithId[],
  rules: TierRules,
  dir: 1 | -1,
): CustomerChange[] {
  const out: CustomerChange[] = [];
  for (const c of customers) {
    for (const row of before.rows) {
      const from = customerPrice(before, row.ref, c, rules);
      const to = customerPrice(after, row.ref, c, rules);
      if (from === to) continue;
      const against = Math.sign(to - from) !== dir;
      const drift =
        customerPriceExact(afterUnrounded, row.ref, c, rules) -
        customerPriceExact(before, row.ref, c, rules);
      const exact = Math.abs(drift) < 1e-9 ? 0 : Math.sign(drift); // float noise is not a move
      const cause = against && exact !== -dir ? "rounding" : "shape";
      out.push({ customerId: c.customerId, ref: row.ref, tier: c.tier, from, to, against, cause });
    }
  }
  return out;
}

/**
 * SA-798 (c): each set customer cell (C, U) moves by the tier ratio, with one rounding and a positive price. Never
 * pre-selected: the caller shows it unticked, with the moves as its preview.
 */
function customerMoveOffer(
  before: LadderView,
  after: LadderView,
  customers: readonly CustomerPricingWithId[],
  rules: TierRules,
  dir: 1 | -1,
): CustomerMoveOffer | null {
  const moves: CustomerMoveOffer["moves"] = [];
  for (const c of customers) {
    const k = customerAnchor(before, c);
    for (const [ref, from] of Object.entries(c.set ?? {})) {
      if (!(from > 0) || !before.rows.some((r) => r.ref === ref)) continue;
      const den = ladderPriceExact(before, ref, c.tier, rules, k);
      if (!(den > 0)) continue;
      const to = scalePrice(from, ladderPriceExact(after, ref, c.tier, rules, k), den);
      if (to > 0 && to !== from) {
        const against = Math.sign(to - from) !== dir;
        moves.push({
          customerId: c.customerId,
          ref,
          tier: c.tier,
          from,
          to,
          against,
          ...(against ? { cause: "shape" as const } : {}),
        });
      }
    }
  }
  if (moves.length === 0) return null;
  const n = moves.length;
  // SA-798a: the owner's verb only while every move goes with the change; otherwise the neutral one.
  const verb = moves.some((m) => m.against) ? "update" : dir > 0 ? "raise" : "lower";
  return {
    kind: "customer",
    ticked: false,
    title: `Also ${verb} prices set for these customers, in step with their tier (${n} price${n === 1 ? "" : "s"}).`,
    moves,
  };
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
  opts: PriceChangeOptions = {},
): PricePlan {
  const refuse = (message: string): PricePlan => emptyPlan(view, [message]);
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
  // The exact price, so an Auto Retail is rounded once, after the change (a Set one is already in cents).
  add(picked.ref, 1, picked.factor, picked.label, ladderPriceExact(view, picked.ref, 1, rules));
  if (change.also) {
    for (const row of view.rows) {
      for (const tier of PRICE_TIERS) {
        const set = row.set[tier - 1];
        if (set != null) add(row.ref, tier, row.factor, row.label, set);
      }
    }
  }
  const patches: CellPatch[] = [];
  const unrounded: CellPatch[] = []; // the same moves before the one rounding: tells a "rounding" cause from a "shape" one
  for (const m of moved.values()) {
    const raw =
      change.mode === "percent"
        ? (m.from * (100 + sign * value)) / 100
        : m.from + (sign * value * m.factor) / picked.factor;
    const to = roundMoney(raw);
    if (!(to > 0)) {
      return refuse(`${m.label} would go to $0.00 or less. Use a smaller change.`);
    }
    if (to !== m.from || priceSource(rowOf(view, m.ref), m.tier) === "auto") {
      patches.push({ ref: m.ref, tier: m.tier, to });
      unrounded.push({ ref: m.ref, tier: m.tier, to: raw });
    }
  }
  const applied = applyCellPatches(view, patches);
  const changes = cellChanges(view, applied.view, rules);
  const customers = opts.customers ?? [];
  const customerOffer = customerMoveOffer(view, applied.view, customers, rules, sign);
  return {
    patches,
    undo: applied.undo,
    followers: followersOf(changes, patches),
    offers: [
      ...inversionOffers(
        applied.view,
        patches.map((p) => ({ ref: p.ref, tier: p.tier })),
        rules,
        tierName,
        view,
      ),
      ...(customerOffer ? [customerOffer] : []),
    ],
    customerChanges: planCustomerChanges(
      view,
      applied.view,
      applyCellPatches(view, unrounded).view,
      customers,
      rules,
      sign,
    ),
    changes,
    problems: [],
    view: applied.view,
  };
}
