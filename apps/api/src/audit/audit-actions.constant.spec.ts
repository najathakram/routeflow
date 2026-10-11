import { API_ERROR_CODES } from "../common/api-error-codes";
import { AUDIT_ACTIONS } from "./audit-actions.constant";

describe("AUDIT_ACTIONS", () => {
  it("pins the counter-sale void action name", () => {
    expect(AUDIT_ACTIONS.COUNTER_SALE_VOIDED).toBe("counter-sale.voided");
  });

  it("pins the STANDARD recorded-refund action name (SA-737)", () => {
    expect(AUDIT_ACTIONS.STANDARD_REFUND_RECORDED).toBe("return.refund-recorded");
  });

  it("has unique values and none collides with an API error code (the parity spec bans bare code literals)", () => {
    const values = Object.values(AUDIT_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
    const codes = new Set<string>(Object.values(API_ERROR_CODES));
    for (const v of values) expect(codes.has(v)).toBe(false);
  });
});
