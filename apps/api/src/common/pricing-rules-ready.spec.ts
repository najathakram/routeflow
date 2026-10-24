import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";
import {
  assertOrderUnitSwitchAllowed,
  assertTierRulesAllowed,
  pricingRulesNotReady,
} from "./pricing-rules-ready";

describe("SA-795 (h): PRICING_RULES_NOT_READY while the pack write path is incomplete", () => {
  it("the 409 has the registered code and a plain message", () => {
    const e = pricingRulesNotReady();
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    const body = e.getResponse() as { code: string; message: string };
    expect(body.code).toBe(API_ERROR_CODES.PRICING_RULES_NOT_READY);
    expect(body.message).toMatch(/not available yet/);
    expect(body.message).not.toContain("—");
  });

  it("every order-unit switch is refused", () => {
    expect(() => assertOrderUnitSwitchAllowed()).toThrow(ConflictException);
  });

  it("the tier-rules writer refuses any percent above 0 and accepts 0% (the default)", () => {
    expect(() => assertTierRulesAllowed({ 2: 8 })).toThrow(ConflictException);
    expect(() => assertTierRulesAllowed({ 2: 0, 3: "0" })).not.toThrow();
    expect(() => assertTierRulesAllowed({})).not.toThrow();
    expect(() => assertTierRulesAllowed(undefined)).not.toThrow();
  });
});
