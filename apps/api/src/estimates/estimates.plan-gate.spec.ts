import "reflect-metadata";
import { EstimatesController } from "./estimates.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

/**
 * WP5a (R3b.3, R3b.5): class-level JwtAuthGuard + RolesGuard + PlanFlagGuard and
 * @RequirePlanFlag("flag.estimates") on EstimatesController. flag.estimates ships
 * dark (DARK_PLAN_FLAGS in plan-flag-policy.ts), so this is a structural/metadata
 * contract check, not a behavioral allow/deny test — PlanFlagGuard's own courtesy-
 * allow behavior is covered by plan-flag.guard.spec.ts.
 */
describe("EstimatesController — plan gate (WP5a)", () => {
  it("sits behind JwtAuthGuard + RolesGuard + PlanFlagGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", EstimatesController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(
      expect.arrayContaining(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]),
    );
  });

  it("carries @RequirePlanFlag('flag.estimates') at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, EstimatesController)).toBe("flag.estimates");
  });

  it("keeps @Roles(OPERATOR) at the class level", () => {
    expect(Reflect.getMetadata(ROLES_KEY, EstimatesController)).toEqual([UserRole.OPERATOR]);
  });

  // Every existing handler is still reachable — the class-level guard doesn't
  // accidentally shadow a route.
  it.each([
    "create",
    "findAll",
    "findOne",
    "send",
    "accept",
    "decline",
    "convertToInvoice",
    "convert",
    "void",
  ])("handler %s still exists on the controller", (handlerName) => {
    expect(
      typeof (EstimatesController.prototype as unknown as Record<string, unknown>)[handlerName],
    ).toBe("function");
  });
});
