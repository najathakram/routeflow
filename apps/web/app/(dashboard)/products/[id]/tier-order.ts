import {
  TIER_FIELDS,
  buildLadderView,
  ladderPrice,
  type PriceTier,
  type TierRules,
} from "@routeflow/pricing";

/**
 * The tier order check for the Details tiers (tiers 2..5, volume discounts get lower as the number rises).
 *
 * With `skipAuto` (the prices grid is on) a tier stored as 0 is Auto: it charges what `@routeflow/pricing` says (Retail
 * less the tenant's tier rule percent for that tier, `rules`; Retail when there is no rule), so the check compares what
 * each tier charges against the effective price of the tier above (Retail for tier 2). An Auto tier below a lower priced
 * tier therefore warns, and a priced tier is checked against an Auto tier above it. Without it (the old page) a 0
 * compares as a price, exactly as before.
 */
export function tiersBreakOrder(
  retail: number,
  tiers: readonly number[],
  idx: number,
  skipAuto: boolean,
  rules?: TierRules,
): boolean {
  if (!skipAuto) return tiers[idx] > (idx === 0 ? retail : tiers[idx - 1]);
  const view = buildLadderView(
    {
      pricePerUnit: retail,
      priceTier2: tiers[0],
      priceTier3: tiers[1],
      priceTier4: tiers[2],
      priceTier5: tiers[3],
    },
    [],
  );
  const eff = (n: PriceTier) => ladderPrice(view, "pack", n, rules);
  return eff((idx + 2) as PriceTier) > eff((idx + 1) as PriceTier);
}

const LADDER_TIER_FIELDS = TIER_FIELDS.slice(1);

/** Does tier `idx` warn while editing? Reads the draft first, then the saved product (a missing tier follows Retail). */
export function tierWarns(
  idx: number,
  draft: Record<string, unknown>,
  product: Record<string, unknown>,
  priceNumber: number,
  skipAuto: boolean,
  rules?: TierRules,
): boolean {
  const retail = parseFloat(String(draft.pricePerUnit ?? priceNumber));
  const tiers = LADDER_TIER_FIELDS.map((f) =>
    parseFloat(String(draft[f] ?? product[f] ?? priceNumber)),
  );
  return tiersBreakOrder(retail, tiers, idx, skipAuto, rules);
}
