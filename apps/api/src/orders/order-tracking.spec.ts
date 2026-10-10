/**
 * #2095 — the tracking payload the buyer portal's "Track your delivery" card reads.
 *
 * - "N stops before you" counts every stop the driver has not finished before this one: a stop
 *   the driver has arrived at and is still working (IN_PROGRESS) stands between them and you just
 *   as a PENDING one does. Finished stops (COMPLETED / SKIPPED) and later stops never count.
 * - A customer-facing caller (the buyer portal's pseudo-user, or a CUSTOMER-role user) gets the
 *   driver's FIRST name only and no route label: the label is the seller's free text and could
 *   name other customers. Staff keep both.
 * - The read itself loads nothing about another stop but its number and status, so nothing else
 *   can leak through this handler.
 *
 * Direct unit tests of `getOrderTracking`; tenant scoping and the buyer guard chain are proven
 * end to end in `buyer/buyer-order-tracking.authz.spec.ts`. Fixtures are placeholders.
 */
import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { makePseudoUser } from "../buyer/buyer.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { driverFirstName, getOrderTracking } from "./order-tracking";

const staff: JwtPayload = {
  sub: "u-op",
  username: "op",
  role: UserRole.OPERATOR,
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: "t-1",
  tenantSlug: "acme",
};

const buyerCtx = { userId: "u-mine", tenantId: "t-1", tenantSlug: "acme" };
const buyer = makePseudoUser(buyerCtx);

const customerRole: JwtPayload = { ...staff, sub: "u-mine", role: UserRole.CUSTOMER };

type Stop = { stopNumber: number; status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" };

function orderOnRun(own: Stop, stops: Stop[], over: { driver?: string | null } = {}) {
  return {
    id: "ord-1",
    customerId: "c-mine",
    status: "CONFIRMED",
    customer: { deliveryWindowStart: "09:00", deliveryWindowEnd: "11:30" },
    routeRunStop: {
      stopNumber: own.stopNumber,
      status: own.status,
      routeRun: {
        id: "run-1",
        status: "IN_PROGRESS",
        scheduledDate: new Date("2026-09-29T00:00:00.000Z"),
        driver:
          over.driver === null ? null : { id: "d-1", contactName: over.driver ?? "Sam Rivera" },
        route: { id: "r-1", name: "Tuesday North" },
        stops,
      },
    },
  };
}

function deps(order: unknown, ownerCustomerId = "c-mine") {
  const findUnique = jest.fn().mockResolvedValue(order);
  const findFirst = jest.fn().mockResolvedValue({ id: ownerCustomerId });
  const scoped = { order: { findUnique }, customer: { findFirst } };
  const prisma = { forTenant: () => scoped } as unknown as PrismaService;
  return { prisma, findUnique, findFirst };
}

describe("getOrderTracking — stops before you (#2095)", () => {
  it("counts a stop the driver is still working (IN_PROGRESS) as a stop before you", async () => {
    const own: Stop = { stopNumber: 4, status: "PENDING" };
    const stops: Stop[] = [
      { stopNumber: 1, status: "COMPLETED" },
      { stopNumber: 2, status: "IN_PROGRESS" },
      { stopNumber: 3, status: "PENDING" },
      own,
      { stopNumber: 5, status: "PENDING" },
    ];
    const result = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", buyer);
    expect(result.tracking?.stopsAhead).toBe(2);
  });

  it("never counts a finished stop (COMPLETED / SKIPPED) or any stop after this one", async () => {
    const own: Stop = { stopNumber: 3, status: "PENDING" };
    const stops: Stop[] = [
      { stopNumber: 1, status: "SKIPPED" },
      { stopNumber: 2, status: "COMPLETED" },
      own,
      { stopNumber: 4, status: "PENDING" },
      { stopNumber: 5, status: "IN_PROGRESS" },
    ];
    const result = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", buyer);
    expect(result.tracking?.stopsAhead).toBe(0);
  });
});

describe("getOrderTracking — what a customer may see (#2095 privacy)", () => {
  const own: Stop = { stopNumber: 2, status: "PENDING" };
  const stops: Stop[] = [{ stopNumber: 1, status: "PENDING" }, own];

  it("a buyer gets exactly the shared DTO: first name only, no route label, the run date as ISO", async () => {
    const result = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", buyer);
    expect(result).toEqual({
      status: "CONFIRMED",
      tracking: {
        runId: "run-1",
        routeName: null,
        driverName: "Sam",
        runStatus: "IN_PROGRESS",
        stopNumber: 2,
        stopStatus: "PENDING",
        stopsAhead: 1,
        scheduledDate: "2026-09-29T00:00:00.000Z",
        estimatedArrivalWindow: { start: "09:00", end: "11:30" },
      },
    });
  });

  it("a CUSTOMER-role user gets the same minimized payload", async () => {
    const result = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", customerRole);
    expect(result.tracking).toEqual(
      expect.objectContaining({ driverName: "Sam", routeName: null }),
    );
  });

  it("staff keep the driver's full name and the route label", async () => {
    const result = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", staff);
    expect(result.tracking).toEqual(
      expect.objectContaining({ driverName: "Sam Rivera", routeName: "Tuesday North" }),
    );
  });

  it("no assigned driver reads null for everyone", async () => {
    const order = orderOnRun(own, stops, { driver: null });
    expect((await getOrderTracking(deps(order), "ord-1", buyer)).tracking?.driverName).toBeNull();
    expect((await getOrderTracking(deps(order), "ord-1", staff)).tracking?.driverName).toBeNull();
  });

  it("the read loads nothing about another stop but its number and status", async () => {
    const d = deps(orderOnRun(own, stops));
    await getOrderTracking(d, "ord-1", buyer);
    const include = d.findUnique.mock.calls[0][0].include;
    expect(include.routeRunStop.include.routeRun.include.stops).toEqual({
      select: { stopNumber: true, status: true },
    });
  });

  it("a buyer principal that overrides its role still has to own the order", async () => {
    // Some buyer routes pass role OPERATOR to skip a userId lookup; the BUYER type must still
    // gate this one (and keep the payload minimized).
    const overridden = makePseudoUser({ ...buyerCtx, role: UserRole.OPERATOR });
    const d = deps(orderOnRun(own, stops), "c-someone-else");
    await expect(getOrderTracking(d, "ord-1", overridden)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(d.findFirst).toHaveBeenCalledWith({ where: { userId: "u-mine", deletedAt: null } });

    const owned = await getOrderTracking(deps(orderOnRun(own, stops)), "ord-1", overridden);
    expect(owned.tracking).toEqual(expect.objectContaining({ driverName: "Sam", routeName: null }));
  });
});

describe("driverFirstName", () => {
  it.each([
    ["Sam Rivera", "Sam"],
    ["  Sam   Rivera  ", "Sam"],
    ["Sam", "Sam"],
    ["Mary-Jane Watson", "Mary-Jane"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ])("%p → %p", (input, expected) => {
    expect(driverFirstName(input)).toBe(expected);
  });
});
