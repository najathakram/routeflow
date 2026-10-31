import { BadRequestException, ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CustomerPriceHistoryController } from "./customer-price-history.controller";

describe("CustomerPriceHistoryController", () => {
  const reflector = new Reflector();

  it("is staff-only: OPERATOR (TENANT_ADMIN passes the hierarchy); never DRIVER or CUSTOMER", () => {
    const roles = reflector.get<UserRole[]>(
      ROLES_KEY,
      CustomerPriceHistoryController.prototype.getPriceHistory,
    );
    expect(roles).toEqual([UserRole.OPERATOR]);
    expect(roles).not.toContain(UserRole.DRIVER);
    expect(roles).not.toContain(UserRole.CUSTOMER);
  });

  it("serves GET customers/:customerId/products/:productId/price-history", () => {
    expect(Reflect.getMetadata("path", CustomerPriceHistoryController)).toBe("customers");
    expect(
      Reflect.getMetadata("path", CustomerPriceHistoryController.prototype.getPriceHistory),
    ).toBe(":customerId/products/:productId/price-history");
  });

  it("passes ids, limit and the caller role to the service", async () => {
    const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
    const controller = new CustomerPriceHistoryController(service as any, {} as any);
    const out = await controller.getPriceHistory("c1", "p1", "40", undefined, {
      role: UserRole.TENANT_ADMIN,
    } as any);
    expect(out).toEqual({ rows: [] });
    expect(service.getHistory).toHaveBeenCalledWith("c1", "p1", {
      limit: "40",
      compare: undefined,
      role: UserRole.TENANT_ADMIN,
    });
  });

  it("#3222 review: excludeOrderId is validated as an optional UUID (a repeated param is a 400, not a 500)", async () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      CustomerPriceHistoryController,
      "getPriceHistory",
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const param = Object.values(args).find((a) => a.data === "excludeOrderId");
    const pipe = param?.pipes?.find((p) => p instanceof ParseUUIDPipe) as ParseUUIDPipe | undefined;
    expect(pipe).toBeDefined();
    const meta = { type: "query" as const, data: "excludeOrderId" };
    await expect(pipe!.transform(undefined as never, meta)).resolves.toBeUndefined();
    const id = "3f2c7a54-1b2c-4d5e-8f90-1234567890ab";
    await expect(pipe!.transform(id, meta)).resolves.toBe(id);
    await expect(pipe!.transform(["a", "b"] as never, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe!.transform("not-a-uuid", meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("hunt2 F6: passes the edited order's id through as excludeOrderId", async () => {
    const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
    const controller = new CustomerPriceHistoryController(service as any, {} as any);
    const caller = { role: UserRole.OPERATOR } as any;
    await controller.getPriceHistory("c1", "p1", undefined, undefined, caller, "o9");
    expect(service.getHistory).toHaveBeenCalledWith("c1", "p1", {
      limit: undefined,
      role: UserRole.OPERATOR,
      excludeOrderId: "o9",
    });
  });

  describe("W-1058 H-2.10: the compare floor's denials are read on the server and passed in", () => {
    const userRow = (denied: string[]) => ({
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ deniedPermissionGroups: denied, permissionsVersion: 1 }),
      },
    });
    const operator = { role: UserRole.OPERATOR, sub: "u1", tenantId: "t1" } as any;

    it("?compare=all by an OPERATOR passes the groups the admin denied", async () => {
      const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
      const prisma = userRow(["ORDERS", "FINANCE"]);
      const controller = new CustomerPriceHistoryController(service as any, prisma as any);
      await controller.getPriceHistory("c1", "p1", undefined, "all", operator);
      const opts = service.getHistory.mock.calls[0][2];
      expect(opts.deniedGroups).toEqual(expect.arrayContaining(["ORDERS", "FINANCE"]));
      expect(opts.deniedGroups).toHaveLength(2);
    });

    it("a TENANT_ADMIN passes none and costs no permissions read", async () => {
      const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
      const prisma = userRow(["ORDERS", "FINANCE"]);
      const controller = new CustomerPriceHistoryController(service as any, prisma as any);
      await controller.getPriceHistory("c1", "p1", undefined, "all", {
        role: UserRole.TENANT_ADMIN,
        sub: "u2",
        tenantId: "t1",
      } as any);
      expect(service.getHistory.mock.calls[0][2].deniedGroups).toEqual([]);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it("without ?compare nothing is read and nothing is passed", async () => {
      const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
      const prisma = userRow(["ORDERS", "FINANCE"]);
      const controller = new CustomerPriceHistoryController(service as any, prisma as any);
      await controller.getPriceHistory("c1", "p1", undefined, undefined, operator);
      expect(service.getHistory.mock.calls[0][2].deniedGroups).toBeUndefined();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it("an OPERATOR whose user row is gone is denied every group (fails closed)", async () => {
      const service = { getHistory: jest.fn().mockResolvedValue({ rows: [] }) };
      const prisma = { user: { findFirst: jest.fn().mockResolvedValue(null) } };
      const controller = new CustomerPriceHistoryController(service as any, prisma as any);
      await controller.getPriceHistory("c1", "p1", undefined, "all", operator);
      expect(service.getHistory.mock.calls[0][2].deniedGroups).toEqual(
        expect.arrayContaining(["ORDERS", "FINANCE"]),
      );
    });
  });
});
