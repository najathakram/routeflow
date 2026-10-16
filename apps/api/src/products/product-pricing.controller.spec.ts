import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { ProductPricingController } from "./product-pricing.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";

/** C0 part B: the price-grid read sits behind the units_prices_v2 plan flag (SA-796 R-5). */
describe("ProductPricingController (units v2)", () => {
  it("mounts at products/:productId", () => {
    expect(Reflect.getMetadata("path", ProductPricingController)).toBe("products/:productId");
  });

  it("carries the plan flag at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, ProductPricingController)).toBe(
      "flag.units_prices_v2",
    );
  });

  it("is guarded by JwtAuthGuard, RolesGuard and PlanFlagGuard, in that order", () => {
    const guards = (Reflect.getMetadata("__guards__", ProductPricingController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]);
  });

  it("GET price-grid is an operator read", () => {
    const handler = ProductPricingController.prototype.priceGrid as unknown as object;
    expect(Reflect.getMetadata("path", handler)).toBe("price-grid");
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
  });
});
