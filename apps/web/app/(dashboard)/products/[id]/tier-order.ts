/**
 * The tier order check for the Details tiers (tiers 2..5, volume discounts get lower as the number rises).
 *
 * With `skipAuto` (the prices grid is on) a tier stored as 0 is Auto: it follows Retail (`getTierPrice`), so it never
 * warns and is skipped as "the tier above"; the comparison runs against the nearest tier above that has a price, else
 * Retail. Without it (the old page) a 0 compares as a price, exactly as before.
 */
export function tiersBreakOrder(
  retail: number,
  tiers: readonly number[],
  idx: number,
  skipAuto: boolean,
): boolean {
  const cur = tiers[idx];
  if (!skipAuto) return cur > (idx === 0 ? retail : tiers[idx - 1]);
  if (!(cur > 0)) return false;
  let above = retail;
  for (let i = idx - 1; i >= 0; i--) {
    if (tiers[i] > 0) {
      above = tiers[i];
      break;
    }
  }
  return cur > above;
}

const TIER_FIELDS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

/** Does tier `idx` warn while editing? Reads the draft first, then the saved product (a missing tier follows Retail). */
export function tierWarns(
  idx: number,
  draft: Record<string, unknown>,
  product: Record<string, unknown>,
  priceNumber: number,
  skipAuto: boolean,
): boolean {
  const retail = parseFloat(String(draft.pricePerUnit ?? priceNumber));
  const tiers = TIER_FIELDS.map((f) => parseFloat(String(draft[f] ?? product[f] ?? priceNumber)));
  return tiersBreakOrder(retail, tiers, idx, skipAuto);
}
