import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ActivateSubscriptionDto } from "./activate-subscription.dto";
import { CreateTenantDto } from "./create-tenant.dto";
import { UpdateTenantPlanDto } from "./update-tenant-plan.dto";

/**
 * SA-1204 PR-1 guard G-a kept CORE and ALL_IN off both admin write DTOs "until PR-2 maps them in
 * plan-catalog.constants.ts". SA-1254 V1 (P-41) is that mapping: both now identity-map, so the
 * DTO lists name them (V1: "the DTO lists"). Accepting a value is not the same as allowing it to
 * be selected. Every admin write still passes `resolvePublishedPlan`, which refuses a key with no
 * published catalog row (V2; pinned in platform-admin.service.spec.ts, "SA-1254 V2").
 */
describe("SA-1254 V1: the admin plan DTOs name CORE and ALL_IN", () => {
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
  const planErrors = (errors: Awaited<ReturnType<typeof validate>>) =>
    errors.filter((e) => e.property === "plan");

  it.each(["CORE", "ALL_IN"])("UpdateTenantPlanDto accepts %s", async (plan) => {
    expect(planErrors(await update(plan))).toHaveLength(0);
  });

  it.each(["CORE", "ALL_IN"])("ActivateSubscriptionDto accepts %s", async (plan) => {
    expect(planErrors(await activate(plan))).toHaveLength(0);
  });

  it.each(["CORE", "ALL_IN"])("CreateTenantDto's plan list accepts %s", async (plan) => {
    const errors = await validate(plainToInstance(CreateTenantDto, { plan }));
    expect(planErrors(errors)).toHaveLength(0);
  });

  it("an off-vocabulary key is still refused at the DTO (PLUS waits for the census)", async () => {
    expect(planErrors(await update("PLUS"))).not.toHaveLength(0);
    expect(planErrors(await activate("PLUS"))).not.toHaveLength(0);
  });
});
