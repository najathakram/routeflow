import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { OrdersController } from "./orders.controller";
import { StockAvailabilityService } from "./stock-availability.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PERMISSION_KEY } from "../auth/permissions/permission.decorators";

/**
 * SA-1086 (LS-5, LS-6): the live-stock read is staff only, under the controller's ORDERS permission,
 * registered above `:id`, and tenant-scoped through `forTenant()`.
 */
const handler = OrdersController.prototype.getStockAvailability;

const contextFor = (role: UserRole): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => OrdersController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role, tenantId: "t1" } }) }),
  }) as unknown as ExecutionContext;

describe("GET /orders/stock-availability", () => {
  it("LS-5: OPERATOR, TENANT_ADMIN and SUPER_ADMIN pass the role guard; CUSTOMER and DRIVER are refused", () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN]) {
      expect(guard.canActivate(contextFor(role))).toBe(true);
    }
    for (const role of [UserRole.CUSTOMER, UserRole.DRIVER]) {
      expect(guard.canActivate(contextFor(role))).toBe(false);
    }
  });

  it("is a GET route under the controller's ORDERS permission, behind the role guard", () => {
    expect(Reflect.getMetadata("path", handler)).toBe("stock-availability");
    expect(Reflect.getMetadata("method", handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata(PERMISSION_KEY, OrdersController)).toBeDefined();
    const guards = Reflect.getMetadata("__guards__", handler) as unknown[];
    expect(guards).toContain(RolesGuard);
  });

  it("is declared above the `:id` route, or Nest reads the word as an order id", () => {
    const names = Object.getOwnPropertyNames(OrdersController.prototype);
    expect(names.indexOf("getStockAvailability")).toBeGreaterThan(-1);
    expect(names.indexOf("getStockAvailability")).toBeLessThan(names.indexOf("findOne"));
  });

  it("splits the comma list, defaults the mode to entry and hands the user and customer to the service", async () => {
    const get = jest.fn().mockResolvedValue({ allowOversell: true, items: [] });
    const controller = new OrdersController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get } as never,
    );
    const user = { role: UserRole.OPERATOR, tenantId: "t1" } as any;
    await controller.getStockAvailability({ productIds: "a, b,,c", customerId: "cu1" }, user);
    expect(get).toHaveBeenCalledWith(["a", "b", "c"], user, "entry", "cu1");
    await controller.getStockAvailability({ productIds: "a", mode: "edit" }, user);
    expect(get).toHaveBeenLastCalledWith(["a"], user, "edit", undefined);
    await controller.getStockAvailability({}, user);
    expect(get).toHaveBeenLastCalledWith([], user, "entry", undefined);
  });
});

describe("StockAvailabilityService", () => {
  it("LS-6: reads products through forTenant(), never the unscoped client", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "p1", currentStock: 4 }]);
    const forTenant = jest.fn(() => ({ product: { findMany } }));
    const prisma = {
      forTenant,
      getTenantId: () => "t1",
      product: { findMany: jest.fn() },
    };
    const service = new StockAvailabilityService(prisma as never, { read: jest.fn() } as never);
    const out = await service.get(
      ["p1", "other-tenant"],
      { role: UserRole.OPERATOR } as any,
      "entry",
    );
    expect(forTenant).toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(out.items).toEqual([{ productId: "p1", availablePieces: 4 }]);
  });
});
