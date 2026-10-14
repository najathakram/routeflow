import { roundMoney } from "./pricing";

export function getTierPrice(product: any, tier: number): number {
  const fallback = Number(product.pricePerUnit) || 0;
  switch (tier) {
    case 1:
      return fallback;
    case 2:
      return Number(product.priceTier2 ?? product.pricePerUnit) || fallback;
    case 3:
      return Number(product.priceTier3 ?? product.pricePerUnit) || fallback;
    case 4:
      return Number(product.priceTier4 ?? product.pricePerUnit) || fallback;
    case 5:
      return Number(product.priceTier5 ?? product.pricePerUnit) || fallback;
    default:
      return fallback;
  }
}

/** The five tier price columns in ladder order. Index 0 (`pricePerUnit`) is Tier 1 / list. */
export type TierField = "pricePerUnit" | "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
export const TIER_FIELDS: readonly TierField[] = [
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
];

/** The four tier columns below the list price (Tier 2..5). */
export type LadderTierField = Exclude<TierField, "pricePerUnit">;
type PriceInput = { toString(): string } | string | number | null | undefined;

/**
 * A committed price change on one rung of the ladder (`field`: oldValue → newValue) carried into the LOWER tiers: the
 * ONE rule every tier and list edit uses on web (detail page, products list) and mobile (P0 2026-10-14, SA ruling A
 * amended; it replaces the old unconditional copy-down, which overcharged: Tier 3 21.00 → 21.25 also set a cheaper
 * Tier 4 / Tier 5 to 21.25). Per lower tier, independently, compared in cents through {@link roundMoney}:
 *  1. equal to oldValue → newValue (a tier that was tracking this rung keeps tracking it);
 *  2. 0 → stays 0 on a LIST change (field = pricePerUnit: 0 already follows the list); takes newValue on a Tier 2-4
 *     change (a fresh product's ladder fills as the operator walks it, never inverting above the rung just set);
 *  3. non-zero and ABOVE newValue → capped to newValue (the ladder never inverts);
 *  4. otherwise untouched.
 * Committing 0 ("follow the list again") moves only tiers equal to oldValue and caps nothing (0 is not a price).
 * Returns ONLY the tiers that change, as 2-dp strings. An unchanged, negative or non-numeric newValue returns {}.
 */
export function applyLadderChange(
  field: TierField,
  oldValue: PriceInput,
  newValue: PriceInput,
  tiers: Partial<Record<LadderTierField, PriceInput>>,
): Partial<Record<LadderTierField, string>> {
  const idx = TIER_FIELDS.indexOf(field);
  const newN = parseFloat(String(newValue ?? ""));
  if (idx < 0 || !Number.isFinite(newN) || newN < 0) return {};
  const oldN = parseFloat(String(oldValue ?? ""));
  const from = Number.isFinite(oldN) ? roundMoney(oldN) : null;
  const to = roundMoney(newN);
  if (from === to) return {};
  const v = to.toFixed(2);
  const patch: Partial<Record<LadderTierField, string>> = {};
  for (let i = idx + 1; i < TIER_FIELDS.length; i++) {
    const f = TIER_FIELDS[i] as LadderTierField;
    const raw = parseFloat(String(tiers[f] ?? 0));
    const tier = Number.isFinite(raw) ? roundMoney(raw) : 0;
    if (tier === to) continue;
    if (tier === 0 && idx === 0) continue; // rule 2 first on a LIST change: 0 follows the list even when it was 0
    if (tier === from)
      patch[f] = v; // rule 1
    else if (to === 0)
      continue; // committing 0: only tracking tiers follow
    else if (tier === 0)
      patch[f] = v; // rule 2 on a Tier 2-4 change (a list change returned above)
    else if (tier > to) patch[f] = v; // rule 3
  }
  return patch;
}

/**
 * The sentence shown after a commit that moved other tiers (SA: never silent): "Also set Tier 4 and Tier 5 to
 * $21.25." `label(n)` gives the tenant's name for tier n. null when nothing moved.
 */
export function ladderChangeNote(
  patch: Partial<Record<LadderTierField, string>>,
  label: (tier: number) => string,
): string | null {
  const moved = TIER_FIELDS.map((f, i) => [f, i + 1] as const).filter(
    ([f]) => f !== "pricePerUnit" && patch[f as LadderTierField] !== undefined,
  );
  if (moved.length === 0) return null;
  const names = moved.map(([, n]) => label(n));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const value = parseFloat(patch[moved[0][0] as LadderTierField] as string);
  return value === 0
    ? `Also set ${list} to follow the list price.`
    : `Also set ${list} to $${value.toFixed(2)}.`;
}
