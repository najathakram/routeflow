// SA-795 (h): tier rules above 0% and order-unit switches stay OFF until every writer of the pack price columns
// (`Product.pricePerUnit`, `priceTier2-5`, `packAuto`) goes through the one write path. Until then the engine runs, but
// every Auto value equals today's and Auto tiers are stored as 0 (fold A2), so the ~20 legacy writers stay correct.
//
// Not only a flag: the writers of the rules setting and the switch endpoints refuse with a 409
// `PRICING_RULES_NOT_READY` (API_ERROR_CODES) while this is false, and a structural spec in apps/api pins that this constant may be
// `true` ONLY when the allow-list of outside writers is empty. The PR that empties the list flips it.
export const PACK_WRITE_PATH_COMPLETE = false;

/** What staff see when the guard refuses. Plain words; the UI also hides the controls. */
export const PRICING_RULES_NOT_READY_MESSAGE =
  "Tier discounts and changing a product's order unit are not available yet. Your prices are unchanged.";

/** True when a tier-rules value asks for any discount: the only values the guard refuses. */
export function tierRulesAboveZero(
  rules: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return Object.values(rules ?? {}).some((v) => Number(v) > 0);
}

/** Thrown by `materializePack` while the write path is incomplete and the ladder needs what the guard refuses. */
export class PricingRulesNotReadyError extends Error {
  readonly code = "PRICING_RULES_NOT_READY";
  constructor() {
    super(PRICING_RULES_NOT_READY_MESSAGE);
    this.name = "PricingRulesNotReadyError";
  }
}
