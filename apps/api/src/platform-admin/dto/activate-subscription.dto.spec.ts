import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ActivateSubscriptionDto } from "./activate-subscription.dto";

/**
 * Phase 0 Task 10 closed the gap this file used to guard: `planKeyFromEnum()` in
 * plan-catalog.constants.ts now identity-maps GROWTH/SCALE instead of falling through to its
 * STARTER default, so SELECTABLE_TENANT_PLANS — and this DTO — accept them.
 */
describe("ActivateSubscriptionDto — plan selectability", () => {
  const base = { paymentMethod: "ZELLE", billingPeriodDays: 30 };
  const run = async (plan: unknown) => {
    const dto = plainToInstance(ActivateSubscriptionDto, { ...base, plan });
    return validate(dto);
  };

  it("accepts GROWTH (Phase 0 Task 10)", async () => {
    const errors = await run("GROWTH");
    expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
  });

  it("accepts SCALE (Phase 0 Task 10)", async () => {
    const errors = await run("SCALE");
    expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
  });

  it("still accepts an existing selectable value", async () => {
    const errors = await run("STARTER");
    expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
  });

  it("rejects a value outside the TenantPlan enum entirely", async () => {
    const errors = await run("NOT_A_REAL_PLAN");
    expect(errors.some((e) => e.property === "plan")).toBe(true);
  });
});
