import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  decideStaffOverride,
  getTierPrice,
  isSpecialPrice,
  type CustomerLayerPrice,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

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
  /** S19, flag.units_prices_v2 only: the pack's customer-layer price, the baseline in place of the tier price. */
  layer?: CustomerLayerPrice | null,
) {
  const decision = decideStaffOverride({
    overridePrice,
    baselinePrice: layer?.price ?? Number(getTierPrice(product, tier)),
    listPrice: layer?.listPrice ?? Number(product.pricePerUnit),
    isSpecialTier: isSpecialPrice(
      tier,
      layer?.listPrice ?? Number(product.pricePerUnit),
      layer?.price,
    ),
    hasReason: !!reason?.trim(),
  });
  if ("refused" in decision) throw specialPriceReasonRequired(product.name);
  // SA-811a R2: the customer's own price above the unit's Retail ladder price is the sticky upsell's twin: MANUAL, but not a
  // staff override (no attribution) when it is only the baseline echoed back.
  if (layer?.aboveList && decision.priceType === "SPECIAL") {
    return { ...decision, priceType: "MANUAL" as const, overridden: false };
  }
  return {
    ...decision,
    overridden: decision.priceType === "DISCOUNTED" || decision.priceType === "MANUAL",
  };
}

/**
 * POS-5: create()'s `priceEditAllowed` option (the counter sale passes `staffMay(role, "EDIT_LINE_PRICE")`).
 * `false` refuses a REAL price change on a line, pack or unit, with the one 403 — judged against the SERVER tier
 * price, before any lock or write. The pack and the unit branch of create() both call this, never their own copy.
 */
export function assertPriceEditAllowed(priceEditAllowed: boolean | undefined): void {
  if (priceEditAllowed === false) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED,
      message: "You can't change prices. Ask your account admin.",
    });
  }
}
