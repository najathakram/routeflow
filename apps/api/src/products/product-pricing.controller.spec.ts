import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
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

  it.each([
    ["savePrices", "prices"],
    ["undoPrices", "prices/undo"],
  ])("POST %s is an operator write at %s answering 200", (name, path) => {
    const handler = (ProductPricingController.prototype as unknown as Record<string, object>)[name];
    expect(Reflect.getMetadata("path", handler)).toBe(path);
    expect(Reflect.getMetadata("method", handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata("__httpCode__", handler)).toBe(200);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
  });

  it("hands the body and the acting user (tenant comes from the JWT context, never the body) to the write service", async () => {
    const writes = {
      save: jest.fn().mockResolvedValue("saved"),
      undo: jest.fn().mockResolvedValue("undone"),
    };
    const controller = new ProductPricingController({} as never, writes as never, {} as never);
    const user = { sub: "u1" } as never;
    const dto = { expectedRevision: 1, expectedPriceState: "s", patches: [] };
    await expect(controller.savePrices("p1", dto, user)).resolves.toBe("saved");
    expect(writes.save).toHaveBeenCalledWith("p1", dto, "u1");
    const undo = { auditId: "a", expectedRevision: 1, expectedPriceState: "s" };
    await expect(controller.undoPrices("p1", undo, user)).resolves.toBe("undone");
    expect(writes.undo).toHaveBeenCalledWith("p1", undo, "u1");
  });
});
