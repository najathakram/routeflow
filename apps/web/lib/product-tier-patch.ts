import { applyLadderChange, roundMoney } from "@routeflow/pricing";

export type TierPriceKey = "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
export const TIER_PRICE_KEYS: readonly TierPriceKey[] = [
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
];
type Price = { toString(): string } | string | number | null | undefined;
export type TierPrices = { pricePerUnit: Price } & Partial<Record<TierPriceKey, Price>>;

const asDecimal = (v: unknown): string | undefined => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n >= 0 ? String(n) : undefined;
};

/**
 * The tier keys of a product PATCH from the detail page's edit form or its variant modal (product page audit
 * 2026-10-14, money). A tier the operator did not touch (its draft still equals the stored value the form showed, in
 * cents) follows a list-price change through `applyLadderChange("pricePerUnit", …)`, the SAME rule as the products list quick-save; a tier
 * the operator typed always wins. Blank or invalid input is never sent (leave unchanged).
 */
export function editTierPatch(
  stored: TierPrices,
  draft: Partial<Record<"pricePerUnit" | TierPriceKey, string | undefined>>,
): Record<TierPriceKey, string | undefined> {
  const untouched: Partial<Record<TierPriceKey, Price>> = {};
  for (const k of TIER_PRICE_KEYS) {
    const shown = parseFloat(String(stored[k] ?? stored.pricePerUnit ?? ""));
    const typed = parseFloat(String(draft[k] ?? ""));
    if (Number.isFinite(typed) && roundMoney(typed) === roundMoney(shown)) untouched[k] = stored[k];
  }
  // A list change is the Tier 1 case of the ONE ladder rule (#3468): equal-to-old moves, 0 stays, above is capped.
  const moved = applyLadderChange(
    "pricePerUnit",
    stored.pricePerUnit,
    draft.pricePerUnit ?? stored.pricePerUnit,
    untouched,
  );
  const out = {} as Record<TierPriceKey, string | undefined>;
  // Only an UNTOUCHED tier may take a moved value: a typed tier is absent from `untouched` (read there as 0), so its
  // own draft always wins, whatever the old list was (#3470 review).
  for (const k of TIER_PRICE_KEYS)
    out[k] = (k in untouched ? moved[k] : undefined) ?? asDecimal(draft[k]);
  return out;
}

/** The tiers a save of this draft would MOVE with the list (for the "tiers will move" note); {} when none. */
export function editTierPatchMoves(
  stored: TierPrices,
  draft: Partial<Record<"pricePerUnit" | TierPriceKey, string | undefined>>,
): Partial<Record<TierPriceKey, string>> {
  const patch = editTierPatch(stored, draft);
  const moves: Partial<Record<TierPriceKey, string>> = {};
  for (const k of TIER_PRICE_KEYS) {
    const typed = parseFloat(String(draft[k] ?? ""));
    const sent = parseFloat(String(patch[k] ?? ""));
    if (
      Number.isFinite(sent) &&
      (!Number.isFinite(typed) || roundMoney(sent) !== roundMoney(typed))
    )
      moves[k] = patch[k];
  }
  return moves;
}
