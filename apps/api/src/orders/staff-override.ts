import { BadRequestException } from "@nestjs/common";
import {
  decideStaffOverride,
  getTierPrice,
  isSpecialTier,
  needsOverrideReason,
} from "@routeflow/pricing";

/** The api's one refusal text for a special-price change with no reason (B465 / B466 / #2696). */
export const specialPriceReasonRequired = (name: string | null | undefined) =>
  new BadRequestException(
    `A reason is required to change ${name ?? "this"} — it's this customer's special price`,
  );

type PricedProduct = { name?: string | null; pricePerUnit: unknown };

/**
 * #2696(c) rule A (SA-558 / 558b / 558d): a staff-typed price on a line priced from the customer's
 * TIER — create, the create auto-merge's new line, substitute — goes through `decideStaffOverride`
 * (@routeflow/pricing, the same function both clients call). Refused ⇒ the product-named 400.
 * `overridden` is true only for a real change (DISCOUNTED / MANUAL); within ½¢ of the tier price the
 * decision is the tier price itself (SPECIAL / STANDARD), no reason, no attribution.
 */
export function decideTierOverride(
  product: PricedProduct,
  tier: number,
  overridePrice: number,
  reason: string | null | undefined,
) {
  const decision = decideStaffOverride({
    overridePrice,
    baselinePrice: Number(getTierPrice(product, tier)),
    listPrice: Number(product.pricePerUnit),
    isSpecialTier: isSpecialTier(tier),
    hasReason: !!reason?.trim(),
  });
  if ("refused" in decision) throw specialPriceReasonRequired(product.name);
  return {
    ...decision,
    overridden: decision.priceType === "DISCOUNTED" || decision.priceType === "MANUAL",
  };
}

/**
 * SA-558b (2): the add-during-edit REASON GUARD only (its classification is untouched): a typed
 * price within ½¢ of the customer's tier price needs no reason.
 */
export function assertTierReasonForAdd(
  product: PricedProduct,
  tier: number,
  overridePrice: number | null,
  reason: string | null | undefined,
): void {
  if (
    overridePrice !== null &&
    needsOverrideReason({
      overridePrice,
      baselinePrice: Number(getTierPrice(product, tier)),
      isSpecialTier: isSpecialTier(tier),
      hasReason: !!reason?.trim(),
    })
  ) {
    throw specialPriceReasonRequired(product.name);
  }
}
