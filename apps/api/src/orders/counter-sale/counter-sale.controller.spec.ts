jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import "reflect-metadata";
import { BadRequestException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@prisma/client";
import { CounterSaleController } from "./counter-sale.controller";
import { CounterSaleDto } from "./counter-sale.dto";
import { RolesGuard } from "../../auth/guards/roles.guard";

/** The HTTP edge of POST /orders/counter-sale: route, role gate, header normalisation, DTO shape. */
describe("CounterSaleController", () => {
  const service = {
    ring: jest.fn().mockResolvedValue({ orderId: "ord-1" }),
    byKey: jest.fn().mockResolvedValue({ orderId: "ord-1", replayed: true }),
  };
  const controller = new CounterSaleController(service as never);
  const user = { sub: "op-1", role: "OPERATOR" } as never;
  const dto = { customerId: "c", items: [], payment: { method: "CASH" } } as never;

  beforeEach(() => {
    service.ring.mockClear();
    service.byKey.mockClear();
  });

  it("is POST /orders/counter-sale", () => {
    expect(Reflect.getMetadata("path", CounterSaleController)).toBe("orders");
    expect(Reflect.getMetadata("path", CounterSaleController.prototype.ring)).toBe("counter-sale");
    expect(Reflect.getMetadata("method", CounterSaleController.prototype.ring)).toBe(1); // RequestMethod.POST
  });

  describe("role gate (the real RolesGuard over the route's metadata)", () => {
    const guard = new RolesGuard(new Reflector());
    const allows = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => CounterSaleController.prototype.ring,
        getClass: () => CounterSaleController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);

    it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s passes", (role) => {
      expect(allows(role)).toBe(true);
    });
    it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s is refused", (role) => {
      expect(allows(role)).toBe(false);
    });
  });

  it("threads a normalised Idempotency-Key through to the service", async () => {
    await controller.ring(dto, user, "  key-123 ");
    expect(service.ring).toHaveBeenCalledWith(dto, user, "key-123");
  });

  it("a missing or blank Idempotency-Key is a coded 400 IDEMPOTENCY_KEY_REQUIRED before the service runs", async () => {
    for (const raw of [undefined, "", "   "]) {
      const e = await controller.ring(dto, user, raw).then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(service.ring).not.toHaveBeenCalled();
  });

  it("an oversized or spaced key is a 400 before the service runs", async () => {
    await expect(controller.ring(dto, user, "x".repeat(129))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.ring(dto, user, "has space")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.ring).not.toHaveBeenCalled();
  });
  describe("GET /orders/counter-sale/by-key/:key", () => {
    it("is a GET on counter-sale/by-key/:key", () => {
      expect(Reflect.getMetadata("path", CounterSaleController.prototype.byKey)).toBe(
        "counter-sale/by-key/:key",
      );
      expect(Reflect.getMetadata("method", CounterSaleController.prototype.byKey)).toBe(0); // GET
    });

    const guard = new RolesGuard(new Reflector());
    const allows = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => CounterSaleController.prototype.byKey,
        getClass: () => CounterSaleController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);
    it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s passes", (role) =>
      expect(allows(role)).toBe(true),
    );
    it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s is refused (403)", (role) =>
      expect(allows(role)).toBe(false),
    );

    it("normalises the key like the header (trim) and asks the service", async () => {
      await controller.byKey("  key-9 ");
      expect(service.byKey).toHaveBeenCalledWith("key-9");
    });

    it("a blank or malformed key is a 400 before the service runs", async () => {
      await expect(controller.byKey("   ")).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.byKey("has space")).rejects.toBeInstanceOf(BadRequestException);
      expect(service.byKey).not.toHaveBeenCalled();
    });
  });
});

describe("CounterSaleDto", () => {
  const check = async (body: unknown) => validate(plainToInstance(CounterSaleDto, body) as object);
  const ok = {
    customerId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    items: [{ productId: "6f9619ff-8b86-4011-b42d-00c04fc964ff", qty: 2 }],
    payment: { method: "CASH", amount: 20 },
  };

  it("accepts the contract shape (named customer, and a walk-in)", async () => {
    expect(await check(ok)).toHaveLength(0);
    expect(
      await check({ walkIn: true, items: ok.items, payment: { method: "CARD" } }),
    ).toHaveLength(0);
  });

  it("refuses no items, a bad payment method, a non-UUID customer, and a negative amount", async () => {
    expect((await check({ ...ok, items: [] })).length).toBeGreaterThan(0);
    expect((await check({ ...ok, payment: { method: "BITCOIN" } })).length).toBeGreaterThan(0);
    expect((await check({ ...ok, customerId: "nope" })).length).toBeGreaterThan(0);
    expect(
      (await check({ ...ok, payment: { method: "CASH", amount: -5 } })).length,
    ).toBeGreaterThan(0);
  });
});
