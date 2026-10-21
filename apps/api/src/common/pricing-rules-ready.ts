import { ConflictException } from "@nestjs/common";
import {
  PACK_WRITE_PATH_COMPLETE,
  PRICING_RULES_NOT_READY_MESSAGE,
  tierRulesAboveZero,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "./api-error-codes";

/**
 * SA-795 (h): the 409 for anything that needs the pack price columns to have ONE writer. Fixed body, nothing written.
 * Used by the tier-rules setting writer (any percent above 0) and by every order-unit switch endpoint (product, tier,
 * customer, "Apply to existing products") while `PACK_WRITE_PATH_COMPLETE` is false.
 */
export function pricingRulesNotReady(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: API_ERROR_CODES.PRICING_RULES_NOT_READY,
    message: PRICING_RULES_NOT_READY_MESSAGE,
  });
}

/** Call at the top of an order-unit switch endpoint (preview and apply). */
export function assertOrderUnitSwitchAllowed(): void {
  if (!PACK_WRITE_PATH_COMPLETE) throw pricingRulesNotReady();
}

/** Call in the tier-rules setting writer. Rules at 0% (the default) always pass. */
export function assertTierRulesAllowed(
  rules: Readonly<Record<string, unknown>> | null | undefined,
): void {
  if (!PACK_WRITE_PATH_COMPLETE && tierRulesAboveZero(rules)) throw pricingRulesNotReady();
}
