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

/**
 * Tier-edit cascade: COMMITTING a new price on tier N copies it down to every lower tier
 * (N+1..5) unconditionally, so an operator can walk the ladder setting each break once.
 * Returns ONLY the cascaded fields, as 2-dp decimal strings (ready for a form draft or a
 * PATCH payload); the edited field itself stays the caller's own write.
 *
 * Returns {} for tier 5 (nothing below it), negative, or non-finite input.
 *
 * NOT used for Tier 1 / `pricePerUnit` — the list price keeps its existing "smart" behavior
 * (only tiers that still matched the OLD list price follow it), which preserves a
 * deliberately customized ladder when the list price is re-priced.
 *
 * Committing 0 cascades an explicit "0.00", which under getTierPrice's `|| fallback` guard
 * means "these tiers inherit the list price again" — that is intended.
 *
 * Change detection ("the user focused and typed but did not actually change anything")
 * belongs to the caller's commit mechanism, never to this function.
 *
 * REG-B122: the cent rounding MUST go through {@link roundMoney} — never re-inline a
 * rounding expression here. An inlined `+ Number.EPSILON` nudge round-DOWNS every
 * half-cent value (2.135 -> "2.13"), which is a tier price a cent below what the same
 * number becomes on every other money path.
 */
export function cascadeTierPrices(
  field: TierField,
  value: number,
): Partial<Record<TierField, string>> {
  const idx = TIER_FIELDS.indexOf(field);
  if (idx < 1 || !Number.isFinite(value) || value < 0) return {};
  const v = roundMoney(Math.abs(value)).toFixed(2);
  const patch: Partial<Record<TierField, string>> = {};
  for (let i = idx + 1; i < TIER_FIELDS.length; i++) patch[TIER_FIELDS[i]] = v;
  return patch;
}
