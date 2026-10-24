import { tierLabel } from "./tier-label";

/** The app's name for the base price when the tenant has not relabeled tier 1. */
export const TIER_ONE_DEFAULT_LABEL = "Retail";

type TierLabels = Record<string, string> | null | undefined;

/**
 * The ONE name the product page uses for the base price (tier 1): the tenant's configured label,
 * else "Retail". A blank configured label counts as unset. Never "Tier 1" (P02).
 */
export function tierOneLabel(labels: TierLabels): string {
  return labels?.["1"]?.trim() || TIER_ONE_DEFAULT_LABEL;
}

/** Product-page tier label: tier 1 through `tierOneLabel`, every other tier through `tierLabel`. */
export function productTierLabel(
  labels: TierLabels,
  n: number | string | null | undefined,
): string {
  return Number(n) === 1 ? tierOneLabel(labels) : tierLabel(labels, n);
}
