import { roundMoney } from "./pricing";

// Multi-level units (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §2. A `ProductUnit`
// row's price is either explicit (tier 1 `price` or the matching `priceTierN`)
// or derived — proportional to the pack's own tier ladder when tier 1 is
// explicit, else a straight factor ratio off the pack. One rounding, at the end.

export interface ResolveUnitPriceLevel {
  factorToBase: number;
  price: number | null;
  priceTier2: number | null;
  priceTier3: number | null;
  priceTier4: number | null;
  priceTier5: number | null;
}

export interface ResolveUnitPriceInput {
  /** The pack's tier-1 price (Product.pricePerUnit). */
  packPrice: number;
  /** Pieces per pack (Product.unitsPerBox). */
  packFactor: number;
  /** The pack's own price AT the requested tier (== packPrice when tier === 1). */
  tierPackPrice: number;
  level: ResolveUnitPriceLevel;
  tier: 1 | 2 | 3 | 4 | 5;
}

/** Price for a `ProductUnit` level at a given customer tier. */
export function resolveUnitPrice(input: ResolveUnitPriceInput): number {
  const { packPrice, packFactor, tierPackPrice, level, tier } = input;
  const explicit =
    tier === 1
      ? level.price
      : tier === 2
        ? level.priceTier2
        : tier === 3
          ? level.priceTier3
          : tier === 4
            ? level.priceTier4
            : level.priceTier5;
  if (explicit != null) return roundMoney(explicit);
  if (level.price != null) return roundMoney((level.price * tierPackPrice) / packPrice);
  return roundMoney((tierPackPrice * level.factorToBase) / packFactor);
}
