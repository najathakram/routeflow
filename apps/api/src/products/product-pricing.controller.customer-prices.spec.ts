import "reflect-metadata";
import { ExecutionContext, NotFoundException, RequestMethod } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ProductCustomerPricesService } from "./product-customer-prices.service";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";
import { ProductPricingController } from "./product-pricing.controller";

/** GET products/:productId/customer-prices sits on the same controller, so it has the price-grid's guards and flag. */
describe("ProductPricingController: GET customer-prices", () => {
  const customerPrices = { get: jest.fn() };
  let controller: ProductPricingController;
  const allow = { canActivate: (_c: ExecutionContext) => true };

  beforeEach(async () => {
    customerPrices.get.mockReset();
    const module = await Test.createTestingModule({
      controllers: [ProductPricingController],
      providers: [
        { provide: ProductPriceGridService, useValue: {} },
        { provide: ProductPriceWriteService, useValue: {} },
        { provide: ProductCustomerPricesService, useValue: customerPrices },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .overrideGuard(PlanFlagGuard)
      .useValue(allow)
      .compile();
    controller = module.get(ProductPricingController);
  });

  it("is a GET at customer-prices, an operator read like price-grid", () => {
    const handler = ProductPricingController.prototype.customerPrices as unknown as object;
    expect(Reflect.getMetadata("path", handler)).toBe("customer-prices");
    expect(Reflect.getMetadata("method", handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
    const grid = ProductPricingController.prototype.priceGrid as unknown as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(Reflect.getMetadata(ROLES_KEY, grid));
  });

  it("shares price-grid's class-level guards and the units_prices_v2 plan flag", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, ProductPricingController)).toBe(
      "flag.units_prices_v2",
    );
    const guards = (Reflect.getMetadata("__guards__", ProductPricingController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]);
  });

  it("hands the product id (the tenant comes from the request context, never the URL) to the service", async () => {
    const body = { productId: "p1", revision: 3, customers: [], truncated: false };
    customerPrices.get.mockResolvedValue(body);
    await expect(controller.customerPrices("p1")).resolves.toBe(body);
    expect(customerPrices.get).toHaveBeenCalledWith("p1");
  });

  it("lets the service's 404 through", async () => {
    customerPrices.get.mockRejectedValue(new NotFoundException("Product not found"));
    await expect(controller.customerPrices("other-tenants")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
