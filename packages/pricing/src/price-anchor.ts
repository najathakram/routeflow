import { roundMoney } from "./pricing";
import {
  PACK_WRITE_PATH_COMPLETE,
  PricingRulesNotReadyError,
  tierRulesAboveZero,
} from "./pack-write-path";
import {
  DEFAULT_TIER_RULES,
  PRICE_TIERS,
  ladderPrice,
  ladderPriceExact,
  priceSource,
  rowOf,
  type LadderRow,
  type LadderView,
  type PriceTier,
  type TierRules,
  type UnitRef,
} from "./price-ladder";

// Units and prices, anchor engine (PLAN product-units-pricing §1.3 P4c, P7, P8; SA-795 folds A1, A2).
// Pure functions over a LadderView. Nothing here writes: the API owns the one write path and the revision check.

// ─── P4c: what one customer pays ──────────────────────────────────────────────────────────────

export interface CustomerPricing {
  /** The customer's pricing tier (1 = Retail). */
  tier: PriceTier;
  /** The customer's own order unit for this product. A ref the ladder lacks is skipped (the tier's anchor wins). */
  orderUnit?: UnitRef | null;
  /** The customer's typed prices by unit; only positive numbers count. */
  set?: Readonly<Record<UnitRef, number>>;
}

const positive = (v: number | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** K_C: the customer's own order unit when the ladder has it, else the anchor of the customer's tier column. */
export function customerAnchor(view: LadderView, customer: CustomerPricing): UnitRef {
  const own = customer.orderUnit;
  if (own && view.rows.some((x) => x.ref === own)) return own;
  return customer.tier === 1 ? view.anchor : (view.tierAnchors[customer.tier] ?? view.anchor);
}

/**
 * The price customer C pays for unit U, unrounded. Order: C's typed price for U; else, when C has a typed price on
 * C's order unit K, U keeps the shape of the price C would otherwise pay (D3 proportional, fold A1: the CUSTOMER'S TIER
 * column, so for tier 1 it is U.Retail x C(K) / K.Retail); else tier N's column with K as its anchor.
 */
export function customerPriceExact(
  view: LadderView,
  ref: UnitRef,
  customer: CustomerPricing,
  rules: TierRules = DEFAULT_TIER_RULES,
): number {
  const typed = positive(customer.set?.[ref]);
  if (typed != null) return typed;
  const tier = customer.tier;
  const tierAnchor = tier === 1 ? view.anchor : (view.tierAnchors[tier] ?? view.anchor);
  const k = customerAnchor(view, customer);
  const kTyped = positive(customer.set?.[k]);
  if (kTyped != null) {
    const kA = k === tierAnchor ? undefined : k; // the shape is read on C's own anchor (A1)
    const kPrice = ladderPriceExact(view, k, tier, rules, kA);
    const uPrice = ladderPriceExact(view, ref, tier, rules, kA);
    return kPrice > 0 ? (uPrice * kTyped) / kPrice : uPrice;
  }
  if (tier === 1 || k === tierAnchor) return ladderPriceExact(view, ref, tier, rules);
  return ladderPriceExact(view, ref, tier, rules, k);
}

export function customerPrice(
  view: LadderView,
  ref: UnitRef,
  customer: CustomerPricing,
  rules: TierRules = DEFAULT_TIER_RULES,
): number {
  return roundMoney(customerPriceExact(view, ref, customer, rules));
}

// ─── P7: switching an order unit ──────────────────────────────────────────────────────────────

export type SwitchScope =
  | { kind: "product" }
  | { kind: "tier"; tier: 2 | 3 | 4 | 5 }
  | { kind: "customer"; customer: CustomerPricing };

export interface CellRef {
  ref: UnitRef;
  tier: PriceTier;
}
export interface Pin extends CellRef {
  /** The price kept as a typed (set) price, in cents. */
  value: number;
}
export interface CellChange extends CellRef {
  label: string;
  from: number;
  to: number;
}

export interface SwitchPlan {
  scope: SwitchScope;
  from: UnitRef;
  to: UnitRef;
  /** Cells that become Set: the new anchor's Retail at product scope (P1), then every Keep. */
  pins: Pin[];
  /** Auto prices that move, old to new, after the pins. Empty when nothing moves. */
  changes: CellChange[];
  /** The ladder after the switch (product and tier scope), pins applied. */
  view: LadderView;
  /** The customer after the switch (customer scope), pins applied. */
  customer?: CustomerPricing;
}

const withSet = (view: LadderView, ref: UnitRef, tier: PriceTier, value: number): LadderView => ({
  ...view,
  rows: view.rows.map((r) =>
    r.ref === ref ? { ...r, set: r.set.map((v, i) => (i === tier - 1 ? value : v)) } : r,
  ),
});

/**
 * P7: change the order unit at one scope and list every price that moves. Set prices never change. That scope's Auto
 * prices re-work from the new anchor. At product scope the new anchor's Retail is kept as a set price if it was Auto (P1);
 * tier and customer scope pin nothing by themselves. `keep` pins more cells at their CURRENT value, and the preview
 * is recomputed with them. Apply is the caller's single write under a revision check.
 */
export function planOrderUnitSwitch(
  view: LadderView,
  scope: SwitchScope,
  to: UnitRef,
  opts: { rules?: TierRules; keep?: readonly CellRef[] } = {},
): SwitchPlan {
  const rules = opts.rules ?? DEFAULT_TIER_RULES;
  if (!view.rows.some((r) => r.ref === to)) throw new Error(`Unknown unit "${to}" in this ladder`);
  const customer = scope.kind === "customer" ? scope.customer : undefined;
  const tierColumn = (t: 2 | 3 | 4 | 5) => view.tierAnchors[t] ?? view.anchor;
  const from =
    scope.kind === "product"
      ? view.anchor
      : scope.kind === "tier"
        ? tierColumn(scope.tier)
        : (customer!.orderUnit ??
          (customer!.tier === 1 ? view.anchor : tierColumn(customer!.tier)));

  const priceNow = (v: LadderView, c: CustomerPricing | undefined, r: UnitRef, t: PriceTier) =>
    c ? customerPrice(v, r, c, rules) : ladderPrice(v, r, t, rules);

  let next: LadderView = view;
  const nextCustomer = customer && { ...customer, set: { ...customer.set } };
  if (scope.kind === "product") next = { ...view, anchor: to };
  if (scope.kind === "tier") {
    const tierAnchors = { ...view.tierAnchors, [scope.tier]: to };
    if (to === view.anchor) delete tierAnchors[scope.tier];
    next = { ...view, tierAnchors };
  }
  if (nextCustomer) nextCustomer.orderUnit = to;

  const isAuto = (r: UnitRef, t: PriceTier): boolean =>
    customer ? positive(customer.set?.[r]) == null : priceSource(rowOf(view, r), t) === "auto";
  const pins: Pin[] = [];
  const pin = (r: UnitRef, t: PriceTier) => {
    if (pins.some((p) => p.ref === r && p.tier === t) || !isAuto(r, t)) return;
    const value = priceNow(view, customer, r, t);
    pins.push({ ref: r, tier: t, value });
    if (nextCustomer) nextCustomer.set = { ...nextCustomer.set, [r]: value };
    else next = withSet(next, r, t, value);
  };
  if (scope.kind === "product") pin(to, 1); // P1: the new anchor's Retail is always set
  for (const k of opts.keep ?? []) {
    if (view.rows.some((r) => r.ref === k.ref)) pin(k.ref, customer ? customer.tier : k.tier);
  }

  const tiers: readonly PriceTier[] =
    scope.kind === "product"
      ? PRICE_TIERS
      : scope.kind === "tier"
        ? [scope.tier]
        : [customer!.tier];
  const changes: CellChange[] = [];
  for (const row of view.rows) {
    for (const tier of tiers) {
      if (!isAuto(row.ref, tier)) continue;
      const before = priceNow(view, customer, row.ref, tier);
      const after = priceNow(next, nextCustomer, row.ref, tier);
      if (before !== after)
        changes.push({ ref: row.ref, label: row.label, tier, from: before, to: after });
    }
  }
  return {
    scope,
    from,
    to,
    pins,
    changes,
    view: next,
    ...(nextCustomer ? { customer: nextCustomer } : {}),
  };
}

// ─── P8: the materialized pack ────────────────────────────────────────────────────────────────

export interface MaterializedPack {
  pricePerUnit: number;
  priceTier2: number;
  priceTier3: number;
  priceTier4: number;
  priceTier5: number;
  /** Bit i set = pack cell i (0 = Retail, 1..4 = tiers 2..5) is Auto. */
  packAuto: number;
}

/**
 * The values the pack columns must hold so `getTierPrice` and every raw reader see the right price. Set cells keep their
 * typed value. An Auto Retail (only when another unit anchors) is stored as its number. Fold A2: an Auto tier whose value
 * equals the list price is stored as 0 (its bit set), never as the copied number, so a later change of `pricePerUnit` by
 * any legacy writer still carries it; a number is stored only when it differs (a tier rule above 0%, or a tier anchored
 * on another unit).
 */
export function materializePack(
  view: LadderView,
  rules: TierRules = DEFAULT_TIER_RULES,
  opts: { writePathComplete?: boolean } = {},
): MaterializedPack {
  // SA-795 (h), fold F1: until every legacy writer goes through the write path, only the pack anchor at 0% may be stored.
  const needsWritePath =
    view.anchor !== "pack" || Object.keys(view.tierAnchors).length > 0 || tierRulesAboveZero(rules);
  if (needsWritePath && !(opts.writePathComplete ?? PACK_WRITE_PATH_COMPLETE)) {
    throw new PricingRulesNotReadyError();
  }
  const pack: LadderRow = rowOf(view, "pack");
  let packAuto = 0;
  let retail = pack.set[0];
  if (retail == null) {
    retail = ladderPrice(view, "pack", 1, rules);
    packAuto |= 1;
  }
  const tiers = ([2, 3, 4, 5] as const).map((tier) => {
    const typed = pack.set[tier - 1];
    if (typed != null) return typed;
    packAuto |= 1 << (tier - 1);
    const value = ladderPrice(view, "pack", tier, rules);
    return roundMoney(value) === roundMoney(retail) ? 0 : value;
  });
  return {
    pricePerUnit: retail,
    priceTier2: tiers[0],
    priceTier3: tiers[1],
    priceTier4: tiers[2],
    priceTier5: tiers[3],
    packAuto,
  };
}
