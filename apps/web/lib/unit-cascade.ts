import { roundMoney } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";

export type CascadeField = "price" | "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
/** Tier 1..5 in ladder order — index i is tier i+1. */
export const CASCADE_FIELDS: readonly CascadeField[] = [
  "price",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
];

export interface CascadeChange {
  field: CascadeField;
  /** 1..5 */
  tier: number;
  from: number;
  to: number;
}

export interface CascadeProposal {
  unitId: string;
  label: string;
  changes: CascadeChange[];
}

const explicit = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The yes/no prompt (units plan ask 2), for EVERY tier. When the operator changes one level's
 * explicit price at tier N from `old[N]` to `new[N]`, every OTHER level that holds an explicit
 * price at that SAME tier is offered the same proportional move (`price × new ÷ old`, one
 * rounding per price). Tiers are independent — a tier-2 edit never touches anyone's tier 1 — and
 * a level's derived (blank) prices follow automatically, so they never appear here.
 *
 * `oldPrices`/`newPrices` are indexed by tier (0 = tier 1). A tier with no real change, or a
 * non-positive old/new price (no ratio to apply, e.g. a price newly set or cleared), proposes
 * nothing. Returns [] when there is nothing to offer.
 */
export function proposeCascade(
  units: readonly ProductUnitLevel[],
  editedUnitId: string,
  oldPrices: ReadonlyArray<number | null>,
  newPrices: ReadonlyArray<number | null>,
): CascadeProposal[] {
  const out: CascadeProposal[] = [];
  for (const u of units) {
    if (u.id === editedUnitId) continue;
    const changes: CascadeChange[] = [];
    CASCADE_FIELDS.forEach((field, i) => {
      const oldP = oldPrices[i];
      const newP = newPrices[i];
      if (oldP == null || newP == null || !(oldP > 0) || !(newP > 0) || oldP === newP) return;
      const from = explicit(u[field]);
      if (from == null) return;
      const to = roundMoney((from * newP) / oldP);
      if (to !== from) changes.push({ field, tier: i + 1, from, to });
    });
    if (changes.length > 0) out.push({ unitId: u.id, label: u.label, changes });
  }
  return out;
}

/** The PATCH body that applies one proposal. */
export const cascadePatch = (p: CascadeProposal): Partial<Record<CascadeField, number>> =>
  Object.fromEntries(p.changes.map((c) => [c.field, c.to]));
