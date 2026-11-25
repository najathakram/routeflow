import { isPackUnitWord, priceUnitWord, pricedPerLabel, unitWords } from "@routeflow/pricing";

// The word a price is quoted per lives in pricing (receipt-line-detail.ts) so the emailed receipt reads the same word; re-exported here.
export { priceUnitWord };

/** True when the selling unit is a pack, so "Units per {pack}" belongs next to the price. */
export const isPackUnit = isPackUnitWord;

/**
 * The product detail's price row: "Price each (tier 1)" for an each-priced product (never "Price per each"), "Price
 * per case (tier 1)" for a pack unit. A default "Tier N" name reads lower case inside the parentheses; a tenant's own
 * tier name is left exactly as they wrote it.
 */
export function priceRowLabel(
  unit: string | null | undefined,
  tierName: string,
  pack?: { unitsPerBox?: number | null; packLabel?: string | null },
): string {
  const tier = /^Tier \d+$/.test(tierName) ? tierName.toLowerCase() : tierName;
  // B1383: a boxed product's price is the BOX price; the label comes from pricing, never built here
  const l = pricedPerLabel({ unit: priceUnitWord(unit), ...pack });
  return l.detail ? `${l.short} (${l.detail}, ${tier})` : `${l.short} (${tier})`;
}

/**
 * SA-1069 U-2: the label of a price field, named after the unit the price is quoted per. A plain each-priced line reads
 * "Price each" (never "Price per each"), the same rule as `priceRowLabel`; a pack or a picked unit reads "Price per Case".
 */
export function priceFieldLabel(unitWord: string): string {
  const t = unitWord.trim().toLowerCase();
  return pricedPerLabel({ unit: !t || t === "unit" ? "each" : unitWord }).label;
}

/**
 * The word an order line's price is quoted per, the one the line already shows: the unit the staff picked ("Case"),
 * else the product's pack word for a pack line ("Box" when the product carries only the default), else the plain
 * line's own selling word ("each", "lb"). `unitWords` supplies the pack word so a tenant's own label wins.
 */
export function priceFieldUnitWord(line: {
  unitLabel?: string | null;
  unit?: string | null;
  packUnit?: string | null;
  unitsPerBox?: number | null;
  packUnitsPerBox?: number | null;
}): string {
  const picked = (line.unitLabel ?? "").trim();
  if (picked) return picked;
  const packSize = line.packUnitsPerBox ?? line.unitsPerBox ?? 0;
  const own = (line.packUnit ?? line.unit ?? "").trim();
  const isPlainWord = !own || own.toLowerCase() === "each" || own.toLowerCase() === "unit";
  // B1383 (Q12): a piece word ("can") is NOT the pack's name; only a pack word ("case") is. Otherwise the pack reads "Box".
  if (packSize > 1) return unitWords({ packLabel: isPackUnitWord(own) ? own : null }).pack.one;
  return isPlainWord ? "each" : own;
}
