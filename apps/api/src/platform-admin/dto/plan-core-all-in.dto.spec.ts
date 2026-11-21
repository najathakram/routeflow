import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ActivateSubscriptionDto } from "./activate-subscription.dto";
import { UpdateTenantPlanDto } from "./update-tenant-plan.dto";

/**
 * SA-1204 PR-1 guard G-a: the TenantPlan enum gains CORE and ALL_IN, but nothing may select or
 * write them until PR-2 maps them in plan-catalog.constants.ts. Both admin write DTOs stay
 * closed to the new values while SELECTABLE_TENANT_PLANS is unchanged.
 */
describe("SA-1204 PR-1: CORE and ALL_IN are refused by the admin plan DTOs", () => {
  const update = async (plan: string) =>
    validate(plainToInstance(UpdateTenantPlanDto, { plan, reason: "Plan move for the test" }));
  const activate = async (plan: string) =>
    validate(
      plainToInstance(ActivateSubscriptionDto, {
        plan,
        paymentMethod: "ZELLE",
        billingPeriodDays: 30,
      }),
    );

  it.each(["CORE", "ALL_IN"])("UpdateTenantPlanDto rejects %s", async (plan) => {
    const errors = await update(plan);
    expect(errors.filter((e) => e.property === "plan")).not.toHaveLength(0);
  });

  it.each(["CORE", "ALL_IN"])("ActivateSubscriptionDto rejects %s", async (plan) => {
    const errors = await activate(plan);
    expect(errors.filter((e) => e.property === "plan")).not.toHaveLength(0);
  });
});
