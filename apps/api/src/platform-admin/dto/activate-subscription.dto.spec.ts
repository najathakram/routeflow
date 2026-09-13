import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ActivateSubscriptionDto } from "./activate-subscription.dto";

/**
 * Phase 0 (2026-09-13, PR #718 fix round): the `TenantPlan` Prisma enum widened to include
 * GROWTH and SCALE ahead of Task 10's catalog entries. `planKeyFromEnum()` in
 * plan-catalog.constants.ts doesn't know those two yet and silently falls to its default STARTER
 * branch, so this DTO must keep rejecting them until Task 10 lands — see
 * `SELECTABLE_TENANT_PLANS`.
 */
describe("ActivateSubscriptionDto — plan selectability", () => {
  const base = { paymentMethod: "ZELLE", billingPeriodDays: 30 };
  const run = async (plan: unknown) => {
    const dto = plainToInstance(ActivateSubscriptionDto, { ...base, plan });
    return validate(dto);
  };

  it("rejects GROWTH (not yet selectable — Phase 0 Task 10 gap)", async () => {
    const errors = await run("GROWTH");
    expect(errors.some((e) => e.property === "plan")).toBe(true);
  });

  it("rejects SCALE (not yet selectable — Phase 0 Task 10 gap)", async () => {
    const errors = await run("SCALE");
    expect(errors.some((e) => e.property === "plan")).toBe(true);
  });

  it("still accepts an existing selectable value", async () => {
    const errors = await run("STARTER");
    expect(errors.filter((e) => e.property === "plan")).toHaveLength(0);
  });
});
