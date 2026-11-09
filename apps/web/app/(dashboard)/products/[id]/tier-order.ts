/**
 * The tier order check for the Details tiers (tiers 2..5, volume discounts get lower as the number rises).
 *
 * With `skipAuto` (the prices grid is on) a tier stored as 0 is Auto: it charges Retail (`getTierPrice`), so the check
 * compares what each tier charges, `effective = tier > 0 ? tier : retail`, against the effective price of the tier
 * above (Retail for tier 2). An Auto tier below a lower priced tier therefore warns, and a priced tier is checked
 * against an Auto tier above it at Retail. Without it (the old page) a 0 compares as a price, exactly as before.
 */
export function tiersBreakOrder(
  retail: number,
  tiers: readonly number[],
  idx: number,
  skipAuto: boolean,
): boolean {
  if (!skipAuto) return tiers[idx] > (idx === 0 ? retail : tiers[idx - 1]);
  const eff = (t: number) => (t > 0 ? t : retail);
  return eff(tiers[idx]) > (idx === 0 ? retail : eff(tiers[idx - 1]));
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
