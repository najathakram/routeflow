import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { resolveOwnCustomerForCreate } from "./own-customer-for-create";

function prismaWith(customer: { id: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(customer);
  const prisma = { forTenant: () => ({ customer: { findFirst } }) } as never;
  return { prisma, findFirst };
}

describe("resolveOwnCustomerForCreate (moved verbatim from OrdersService.create)", () => {
  it("returns the caller's own, non-removed customer id", async () => {
    const { prisma, findFirst } = prismaWith({ id: "c1" });
    await expect(resolveOwnCustomerForCreate(prisma, {}, { sub: "u1" })).resolves.toBe("c1");
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "u1", deletedAt: null } });
  });

  it("refuses a route run or stop link before any read", async () => {
    const { prisma, findFirst } = prismaWith({ id: "c1" });
    await expect(
      resolveOwnCustomerForCreate(prisma, { routeRunId: "r1" }, { sub: "u1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolveOwnCustomerForCreate(prisma, { routeRunStopId: "s1" }, { sub: "u1" }),
    ).rejects.toThrow("Route run linkage is not allowed for customer orders");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("answers 403 CUSTOMER_NOT_LINKED when the customer record is missing or removed", async () => {
    const { prisma } = prismaWith(null);
    await expect(resolveOwnCustomerForCreate(prisma, {}, { sub: "u1" })).rejects.toMatchObject({
      status: 403,
      response: { code: "CUSTOMER_NOT_LINKED", message: "Customer record not found" },
    });
    await expect(resolveOwnCustomerForCreate(prisma, {}, { sub: "u1" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
