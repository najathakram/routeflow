jest.mock("./orders.service", () => ({ OrdersService: class OrdersService {} }));

import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ReadyForPickupController } from "./ready-for-pickup.controller";
import { ReadyForPickupService } from "./ready-for-pickup.service";
import { OrdersModule } from "./orders.module";
import { TillPermissionGuard } from "./counter-sale/till-permission.guard";

/** W-1043 (SA-1062 MUST 15): the HTTP edge. Staff only, no till permission, no money. */
describe("ReadyForPickupController", () => {
  const handler = ReadyForPickupController.prototype.markReady;

  it("is POST /orders/:id/ready-for-pickup answering 200", () => {
    expect(Reflect.getMetadata("path", ReadyForPickupController)).toBe("orders");
    expect(Reflect.getMetadata("path", handler)).toBe(":id/ready-for-pickup");
    expect(Reflect.getMetadata("method", handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata("__httpCode__", handler)).toBe(200);
  });

  it("is registered, with its service, in OrdersModule", () => {
    expect(Reflect.getMetadata("controllers", OrdersModule)).toContain(ReadyForPickupController);
    expect(Reflect.getMetadata("providers", OrdersModule)).toContain(ReadyForPickupService);
  });

  it("takes no till permission guard (it takes no money)", () => {
    const guards = (Reflect.getMetadata("__guards__", handler) ?? []) as unknown[];
    expect(guards).not.toContain(TillPermissionGuard);
  });

  describe("role gate (the real RolesGuard over the route's metadata)", () => {
    const guard = new RolesGuard(new Reflector());
    const allows = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => ReadyForPickupController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);

    it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s passes", (role) => {
      expect(allows(role)).toBe(true);
    });
    it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s is refused (403)", (role) => {
      expect(allows(role)).toBe(false);
    });
  });

  it("threads the id and the user to the service", async () => {
    const service = { markReady: jest.fn().mockResolvedValue({ notice: "SENT" }) };
    const controller = new ReadyForPickupController(service as never);
    const user = { sub: "op-1" } as never;
    await expect(controller.markReady("ord-1", user)).resolves.toEqual({ notice: "SENT" });
    expect(service.markReady).toHaveBeenCalledWith("ord-1", user, {});
  });

  it("threads Send again (resend) to the service", async () => {
    const service = { markReady: jest.fn().mockResolvedValue({ notice: "SENT" }) };
    const controller = new ReadyForPickupController(service as never);
    const user = { sub: "op-1" } as never;
    await controller.markReady("ord-1", user, { resend: true });
    expect(service.markReady).toHaveBeenCalledWith("ord-1", user, { resend: true });
  });

  it("has a staff-only GET /orders/:id/ready-for-pickup beside the POST (W-1060)", () => {
    const get = ReadyForPickupController.prototype.getRecord;
    expect(Reflect.getMetadata("path", get)).toBe(":id/ready-for-pickup");
    expect(Reflect.getMetadata("method", get)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata("__guards__", get)).toContain(RolesGuard);
  });
});
