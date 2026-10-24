import { priceUnitWord, unitWords } from "@routeflow/pricing";

// The word a price is quoted per lives in pricing (receipt-line-detail.ts) so the emailed receipt reads the same word; re-exported here.
export { priceUnitWord };

const PACKISH = new Set(["box", "case", "carton", "pack", "crate", "bundle"]);

/** True when the selling unit is a pack, so "Units per {pack}" belongs next to the price. */
export function isPackUnit(unit: string | null | undefined, packLabel?: string | null): boolean {
  const t = priceUnitWord(unit);
  if (t === "unit") return false;
  const w = unitWords({ packLabel });
  return PACKISH.has(t) || t === w.pack.lower || t === w.pack.lowerOther;
}

/**
 * The product detail's price row: "Price each (tier 1)" for an each-priced product (never "Price per each"), "Price
 * per case (tier 1)" for a pack unit. A default "Tier N" name reads lower case inside the parentheses; a tenant's own
 * tier name is left exactly as they wrote it.
 */
export function priceRowLabel(unit: string | null | undefined, tierName: string): string {
  const word = priceUnitWord(unit);
  const tier = /^Tier \d+$/.test(tierName) ? tierName.toLowerCase() : tierName;
  return word === "each" ? `Price each (${tier})` : `Price per ${word} (${tier})`;
}
