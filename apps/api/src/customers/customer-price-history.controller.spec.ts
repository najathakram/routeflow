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
    const controller = new CustomerPriceHistoryController(service as any);
    const out = await controller.getPriceHistory("c1", "p1", "40", {
      role: UserRole.TENANT_ADMIN,
    } as any);
    expect(out).toEqual({ rows: [] });
    expect(service.getHistory).toHaveBeenCalledWith("c1", "p1", {
      limit: "40",
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
    const controller = new CustomerPriceHistoryController(service as any);
    const caller = { role: UserRole.OPERATOR } as any;
    await controller.getPriceHistory("c1", "p1", undefined, caller, "o9");
    expect(service.getHistory).toHaveBeenCalledWith("c1", "p1", {
      limit: undefined,
      role: UserRole.OPERATOR,
      excludeOrderId: "o9",
    });
  });
});
