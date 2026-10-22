import { ForbiddenException } from "@nestjs/common";
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * SA-763r P-1a red row (2): `PATCH /orders/:id/fulfill-path` switches an open order to PICKUP (POS mode).
 * The DTO accepts it (writable-fulfill-paths.spec.ts); the service needs USE_POS_MODE, refuses it on an
 * active run exactly as it refuses SHIP, and keeps the open-states-only rule. The order then reads as
 * PICKUP and the dispatch readers exclude it (dispatch-path-where.spec.ts).
 */
describe("OrdersService.updateFulfillPath: switch to PICKUP", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const open = (extra: Record<string, unknown> = {}) =>
    h.prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "CONFIRMED",
      routeRunStopId: null,
      routeRunStop: null,
      ...extra,
    });
  const toPickup = (...user: unknown[]) =>
    h.service.updateFulfillPath(
      "ord-1",
      { fulfillPath: "PICKUP" } as any,
      (user.length ? user[0] : operatorPayload) as any,
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    // BO-07: an OPERATOR switching to PICKUP is judged on the live user row; this one denies nothing.
    h.prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: [],
      permissionsVersion: 1,
    });
    h.prisma.order.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ord-1", ...a.data }),
    );
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])(
    "%s: a CONFIRMED ROUTE order is stored as PICKUP",
    async (role) => {
      open();
      const out = await toPickup({ ...operatorPayload, role });
      expect(h.prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { fulfillPath: "PICKUP" },
      });
      expect(out.fulfillPath).toBe("PICKUP");
    },
  );

  it.each(["DRAFT", "PENDING", "CONFIRMED", "PROCESSING"])(
    "%s is an open state: allowed",
    async (status) => {
      open({ status });
      await toPickup();
      expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])(
    "%s: refused (open states only), nothing written",
    async (status) => {
      open({ status });
      await expect(toPickup()).rejects.toThrow(/only be changed while the order is open/);
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("a role without USE_POS_MODE (driver, customer, no principal) is refused before anything is read", async () => {
    open();
    for (const user of [{ ...operatorPayload, role: "DRIVER" }, customerPayload, undefined]) {
      await expect(toPickup(user)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(h.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("the 403 carries the stable code POS_MODE_NOT_PERMITTED, for every role that may not switch", async () => {
    open();
    for (const user of [{ ...operatorPayload, role: "DRIVER" }, customerPayload, undefined]) {
      await expect(toPickup(user)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: "POS_MODE_NOT_PERMITTED" }),
      });
    }
  });

  it.each(["SCHEDULED", "IN_PROGRESS"])(
    "an order on a %s run: refused like SHIP, nothing written",
    async (runStatus) => {
      open({
        routeRunStopId: "stop-1",
        routeRunStop: { routeRun: { status: runStatus, driver: { contactName: "Dana" } } },
      });
      await expect(toPickup()).rejects.toThrow(
        /active delivery run with Dana.*switching it to pickup/,
      );
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("a stale attachment (finished run) does not block the switch", async () => {
    open({
      routeRunStopId: "stop-1",
      routeRunStop: { routeRun: { status: "COMPLETED", driver: null } },
    });
    await toPickup();
    expect(h.prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  // B692 class: a PICKUP order left linked to a finished run's stop is skipped by the later stock stamp
  // (it excludes rows carrying a routeRunStopId), so a later quantity cut would restock what was never
  // stamped. The switch lets go of the finished run's link in the same write.
  it.each(["COMPLETED", "CANCELLED"])(
    "a switch off a %s run clears routeRunId AND routeRunStopId, conditional on the link it read",
    async (runStatus) => {
      open({
        routeRunId: "run-1",
        routeRunStopId: "stop-1",
        routeRunStop: { routeRun: { status: runStatus, driver: null } },
        routeRun: { status: runStatus, driver: null },
      });
      await toPickup();
      expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "ord-1", routeRunId: "run-1", routeRunStopId: "stop-1" },
        data: { fulfillPath: "PICKUP", routeRunId: null, routeRunStopId: null },
      });
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("a bare routeRunId (no stop) on a finished run is cleared; the stop id is matched as null", async () => {
    open({ routeRunId: "run-1", routeRun: { status: "COMPLETED", driver: null } });
    await toPickup();
    expect(h.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", routeRunId: "run-1", routeRunStopId: null },
      data: { fulfillPath: "PICKUP", routeRunId: null, routeRunStopId: null },
    });
  });

  it.each(["SCHEDULED", "IN_PROGRESS"])(
    "a bare routeRunId on a %s run (a driver-created order) is refused, link and path untouched",
    async (runStatus) => {
      open({
        routeRunId: "run-1",
        routeRun: { status: runStatus, driver: { contactName: "Dana" } },
      });
      await expect(toPickup()).rejects.toThrow(
        /active delivery run with Dana.*switching it to pickup/,
      );
      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("a link whose run cannot be read fails closed: refused, nothing written", async () => {
    open({ routeRunId: "run-1", routeRun: null });
    await expect(toPickup()).rejects.toThrow(/could not be read/);
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("a dispatch attaching between the read and the write (updateMany count 0) is a coded 409", async () => {
    open({
      routeRunId: "run-1",
      routeRunStopId: "stop-1",
      routeRunStop: { routeRun: { status: "COMPLETED", driver: null } },
      routeRun: { status: "COMPLETED", driver: null },
    });
    h.prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(toPickup()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_RUN_LINK_CHANGED" }),
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("an order with no run link is written exactly as before: the path alone", async () => {
    open();
    await toPickup();
    expect(h.prisma.order.update).toHaveBeenCalledWith({
      where: { id: "ord-1" },
      data: { fulfillPath: "PICKUP" },
    });
  });

  it("only a switch TO pickup lets go of the finished run: SHIP and ROUTE keep the link as today", async () => {
    for (const fulfillPath of ["SHIP", "ROUTE"]) {
      h.prisma.order.update.mockClear();
      open({
        routeRunId: "run-1",
        routeRunStopId: "stop-1",
        routeRunStop: { routeRun: { status: "COMPLETED", driver: null } },
      });
      await h.service.updateFulfillPath("ord-1", { fulfillPath } as any, operatorPayload as any);
      expect(h.prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { fulfillPath },
      });
    }
  });

  it("SHIP on an active run is still refused with the shipping wording; ROUTE is still allowed there", async () => {
    open({
      routeRunStopId: "stop-1",
      routeRunStop: { routeRun: { status: "IN_PROGRESS", driver: null } },
    });
    await expect(
      h.service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload as any),
    ).rejects.toThrow(/switching it to shipping/);
    await h.service.updateFulfillPath(
      "ord-1",
      { fulfillPath: "ROUTE" } as any,
      operatorPayload as any,
    );
    expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
  });
});
