import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import {
  ORDER_DELIVERED_ON_ROUTE_STOP_COPY,
  assertStopDoneForOfficeDelivered,
} from "./office-delivered-route-stop";

/** Row 590 (SA-978a): the refusal's rule, judged from the stop's status alone (the DB lane pins it end to end). */
function prismaWithStop(status: string | null) {
  const findUnique = jest.fn(async () => (status === null ? null : { status }));
  return { prisma: { forTenant: () => ({ routeRunStop: { findUnique } }) } as never, findUnique };
}

describe("assertStopDoneForOfficeDelivered", () => {
  it.each(["PENDING", "IN_PROGRESS", "SKIPPED"])(
    "a %s stop is refused: 409 ORDER_DELIVERED_ON_ROUTE_STOP with the fixed sentence",
    async (status) => {
      const { prisma } = prismaWithStop(status);
      const err: ConflictException = await assertStopDoneForOfficeDelivered(
        prisma,
        { routeRunStopId: "stop-1" },
        OrderStatus.DELIVERED,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: "ORDER_DELIVERED_ON_ROUTE_STOP",
        message: ORDER_DELIVERED_ON_ROUTE_STOP_COPY,
      });
    },
  );

  it("a link whose stop cannot be read fails closed", async () => {
    const { prisma } = prismaWithStop(null);
    await expect(
      assertStopDoneForOfficeDelivered(prisma, { routeRunStopId: "gone" }, OrderStatus.DELIVERED),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("a COMPLETED stop is not refused (the route delivered it)", async () => {
    const { prisma } = prismaWithStop("COMPLETED");
    await expect(
      assertStopDoneForOfficeDelivered(prisma, { routeRunStopId: "s" }, OrderStatus.DELIVERED),
    ).resolves.toBeUndefined();
  });

  it("no run-stop link, or any other target status: no read, no refusal", async () => {
    const { prisma, findUnique } = prismaWithStop("PENDING");
    await assertStopDoneForOfficeDelivered(prisma, { routeRunStopId: null }, OrderStatus.DELIVERED);
    await assertStopDoneForOfficeDelivered(prisma, {}, OrderStatus.DELIVERED);
    await assertStopDoneForOfficeDelivered(
      prisma,
      { routeRunStopId: "s" },
      OrderStatus.OUT_FOR_DELIVERY,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });
});
