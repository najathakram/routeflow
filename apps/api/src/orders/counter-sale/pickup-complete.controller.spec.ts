jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import "reflect-metadata";
import { BadRequestException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@prisma/client";
import { PickupCompleteController } from "./pickup-complete.controller";
import { PickupCompleteDto } from "./pickup-complete.dto";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { OrdersModule } from "../orders.module";

/** The HTTP edge of POST /orders/:id/pickup-complete: route, 200, role gate, header, DTO shape. */
describe("PickupCompleteController", () => {
  const service = { complete: jest.fn().mockResolvedValue({ orderId: "ord-1" }) };
  const controller = new PickupCompleteController(service as never);
  const user = { sub: "op-1", role: "OPERATOR" } as never;
  const dto = { payment: { method: "CASH" } } as never;
  const handler = PickupCompleteController.prototype.complete;

  beforeEach(() => service.complete.mockClear());

  it("is POST /orders/:id/pickup-complete answering 200", () => {
    expect(Reflect.getMetadata("path", PickupCompleteController)).toBe("orders");
    expect(Reflect.getMetadata("path", handler)).toBe(":id/pickup-complete");
    expect(Reflect.getMetadata("method", handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata("__httpCode__", handler)).toBe(200);
  });

  it("is registered in OrdersModule", () => {
    expect(Reflect.getMetadata("controllers", OrdersModule)).toContain(PickupCompleteController);
  });

  describe("role gate (the real RolesGuard over the route's metadata)", () => {
    const guard = new RolesGuard(new Reflector());
    const allows = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => PickupCompleteController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);

    it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s passes", (role) => {
      expect(allows(role)).toBe(true);
    });
    it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s is refused (403)", (role) => {
      expect(allows(role)).toBe(false);
    });
  });

  it("threads the order id, body, user and a normalised Idempotency-Key to the service", async () => {
    await controller.complete("ord-1", dto, user, "  key-123 ");
    expect(service.complete).toHaveBeenCalledWith("ord-1", dto, user, "key-123");
    await controller.complete("ord-1", dto, user, "   ");
    expect(service.complete).toHaveBeenLastCalledWith("ord-1", dto, user, undefined);
  });

  it("an oversized or spaced key is a 400 before the service runs", async () => {
    await expect(controller.complete("ord-1", dto, user, "x".repeat(129))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.complete("ord-1", dto, user, "has space")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.complete).not.toHaveBeenCalled();
  });
});

describe("PickupCompleteDto", () => {
  const check = async (body: unknown) =>
    validate(plainToInstance(PickupCompleteDto, body) as object);

  it("accepts an empty body and every payment method", async () => {
    expect(await check({})).toHaveLength(0);
    for (const method of ["CASH", "CARD", "CHECK", "ON_ACCOUNT"])
      expect(await check({ payment: { method, amount: 10, reference: "r" } })).toHaveLength(0);
  });
  it("refuses a bad method, a negative amount and an oversized reference", async () => {
    expect((await check({ payment: { method: "BITCOIN" } })).length).toBeGreaterThan(0);
    expect((await check({ payment: { method: "CASH", amount: -5 } })).length).toBeGreaterThan(0);
    expect(
      (await check({ payment: { method: "CHECK", reference: "x".repeat(101) } })).length,
    ).toBeGreaterThan(0);
  });
});
