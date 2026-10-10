import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { assertDriverMayEditOrder } from "./driver-edit-access";

/**
 * SA-429 (#2377) — a DRIVER may edit an order's items only when the ORDER's own stop belongs to that
 * driver's IN_PROGRESS run and the stop is PENDING or IN_PROGRESS. Every other case is the same bare
 * 403. Staff and CUSTOMER are untouched. (Real-Postgres pins, incl. the two-connection reassignment
 * race: driver-edit-access.db.spec.ts, run by F2.)
 */

const DENY = "You do not have access to this order";
const driver = { role: UserRole.DRIVER, sub: "u-d" };

function db(opts: {
  driver?: { id: string } | null;
  order?: { routeRunStopId: string | null } | null;
  stop?: { status: string; routeRun: { driverId: string | null; status: string } | null } | null;
}) {
  return {
    driver: { findFirst: jest.fn().mockResolvedValue(opts.driver ?? null) },
    order: { findFirst: jest.fn().mockResolvedValue(opts.order ?? null) },
    routeRunStop: { findFirst: jest.fn().mockResolvedValue(opts.stop ?? null) },
  };
}

const allowed = () =>
  db({
    driver: { id: "d1" },
    order: { routeRunStopId: "s1" },
    stop: { status: "PENDING", routeRun: { driverId: "d1", status: "IN_PROGRESS" } },
  });

describe("assertDriverMayEditOrder (SA-429)", () => {
  it("allows the driver's own IN_PROGRESS run with a PENDING or IN_PROGRESS stop", async () => {
    await expect(assertDriverMayEditOrder(allowed(), "o1", driver)).resolves.toBeUndefined();
    const inProgressStop = db({
      driver: { id: "d1" },
      order: { routeRunStopId: "s1" },
      stop: { status: "IN_PROGRESS", routeRun: { driverId: "d1", status: "IN_PROGRESS" } },
    });
    await expect(assertDriverMayEditOrder(inProgressStop, "o1", driver)).resolves.toBeUndefined();
  });

  it.each([
    ["no Driver row for the user", { driver: null }],
    ["an order that does not exist (or another tenant's)", { driver: { id: "d1" }, order: null }],
    ["an order with no stop", { driver: { id: "d1" }, order: { routeRunStopId: null } }],
    [
      "another driver's run",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "PENDING", routeRun: { driverId: "d2", status: "IN_PROGRESS" } },
      },
    ],
    [
      "the same driver's SCHEDULED run",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "PENDING", routeRun: { driverId: "d1", status: "SCHEDULED" } },
      },
    ],
    [
      "a COMPLETED run",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "PENDING", routeRun: { driverId: "d1", status: "COMPLETED" } },
      },
    ],
    [
      "a CANCELLED run",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "PENDING", routeRun: { driverId: "d1", status: "CANCELLED" } },
      },
    ],
    [
      "a COMPLETED stop",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "COMPLETED", routeRun: { driverId: "d1", status: "IN_PROGRESS" } },
      },
    ],
    [
      "a SKIPPED stop",
      {
        driver: { id: "d1" },
        order: { routeRunStopId: "s1" },
        stop: { status: "SKIPPED", routeRun: { driverId: "d1", status: "IN_PROGRESS" } },
      },
    ],
    [
      "a stop that cannot be read",
      { driver: { id: "d1" }, order: { routeRunStopId: "s1" }, stop: null },
    ],
  ])("%s ⇒ the one bare 403", async (_name, opts) => {
    const err = await assertDriverMayEditOrder(db(opts as any), "o1", driver).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(DENY);
  });

  it("follows the ORDER's own stop (never order.routeRunId) and matches the driver by userId", async () => {
    const d = allowed();
    await assertDriverMayEditOrder(d, "o1", driver);
    expect(d.driver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-d" } }),
    );
    expect(d.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "o1" }, select: { routeRunStopId: true } }),
    );
    expect(d.routeRunStop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" } }),
    );
  });

  it("staff and CUSTOMER are untouched: no read at all", async () => {
    for (const who of [{ role: UserRole.OPERATOR }, { role: UserRole.CUSTOMER }, undefined]) {
      const d = allowed();
      await expect(assertDriverMayEditOrder(d, "o1", who)).resolves.toBeUndefined();
      expect(d.driver.findFirst).not.toHaveBeenCalled();
    }
  });
});

describe("SA-429 placement in OrdersService.updateOrderItems", () => {
  it("is called TWICE: before the order load (so before the cancelled-order 400) and under the lock", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src: string = fs.readFileSync(path.join(__dirname, "orders.service.ts"), "utf8");
    const start = src.indexOf("async updateOrderItems(");
    const body = src.slice(start, src.indexOf("\n  async ", start + 10));
    const calls = [...body.matchAll(/assertDriverMayEditOrder\(([^,]+),/g)];
    expect(calls.map((m) => m[1])).toEqual(["this.prisma.forTenant()", "tx"]);
    const first = body.indexOf("assertDriverMayEditOrder(");
    expect(first).toBeLessThan(body.indexOf("order.findUnique("));
    expect(first).toBeLessThan(body.indexOf(`"Items can't be edited on a cancelled order"`));
    const second = body.indexOf("assertDriverMayEditOrder(tx");
    expect(second).toBeGreaterThan(body.indexOf("FOR UPDATE"));
  });
});

describe("SA-434 (#2391) — driver changeStatus and change-request resolve", () => {
  const { confirmPendingAsDriver, underOrderLockForDriver } =
    require("./driver-edit-access") as typeof import("./driver-edit-access");
  const txWith = (count: number, calls: string[]) => {
    const tx: any = {
      $executeRaw: jest.fn(async () => calls.push("lock")),
      driver: { findFirst: jest.fn(async () => (calls.push("predicate"), { id: "d1" })) },
      order: {
        findFirst: jest.fn(async () => ({ routeRunStopId: "s1" })),
        updateMany: jest.fn(async () => (calls.push("cas"), { count })),
        findUnique: jest.fn(async () => ({ id: "o1", status: "CONFIRMED" })),
      },
      routeRunStop: {
        findFirst: jest.fn(async () => ({
          status: "PENDING",
          routeRun: { driverId: "d1", status: "IN_PROGRESS" },
        })),
      },
    };
    return { tx, prisma: { tenantTransaction: (fn: any) => fn(tx) } };
  };

  it("underOrderLockForDriver: Order lock, THEN the predicate on the tx client, THEN the write", async () => {
    const calls: string[] = [];
    const { prisma } = txWith(1, calls);
    await underOrderLockForDriver(prisma, "o1", driver, async () => calls.push("write"));
    expect(calls).toEqual(["lock", "predicate", "write"]);
  });

  it("confirmPendingAsDriver: a CAS on {id, status: PENDING}; count 0 ⇒ 409 ORDER_CHANGED_DURING_EDIT", async () => {
    const ok = txWith(1, []);
    await expect(
      confirmPendingAsDriver(ok.prisma, "o1", driver, { status: "CONFIRMED" }),
    ).resolves.toMatchObject({ id: "o1" });
    expect(ok.tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: "PENDING" },
      data: { status: "CONFIRMED" },
    });
    const lost = txWith(0, []);
    await expect(
      confirmPendingAsDriver(lost.prisma, "o1", driver, { status: "CONFIRMED" }),
    ).rejects.toMatchObject({ response: { code: "ORDER_CHANGED_DURING_EDIT" } });
  });

  it("source: the predicate is the FIRST statement of changeStatus and of resolve", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    const firstStatement = (src: string, sig: string) => {
      const body = src.slice(src.indexOf(sig));
      const open = body.indexOf("{\n") + 2;
      return body
        .slice(open)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "" && !l.startsWith("//"));
    };
    expect(firstStatement(read("orders.service.ts"), "async changeStatus(")).toMatch(
      /^await driverAccess\.assertDriverMayEditOrder\(this\.prisma\.forTenant\(\), id, user\);/,
    );
    expect(firstStatement(read("change-requests.service.ts"), "async resolve(")).toMatch(
      /^await assertDriverMayEditOrder\(this\.prisma\.forTenant\(\), orderId, user\);/,
    );
  });
});
