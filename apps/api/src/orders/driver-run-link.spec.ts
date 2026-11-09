import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { resolveDriverRunLink } from "./driver-run-link";

// The B309 driver link check, moved verbatim out of OrdersService.create (SA-1124 PR-1a prefactor).
function prismaWith(rows: { driver?: any; stop?: any; run?: any }) {
  const db = {
    driver: { findFirst: jest.fn().mockResolvedValue(rows.driver ?? null) },
    routeRunStop: { findFirst: jest.fn().mockResolvedValue(rows.stop ?? null) },
    routeRun: { findFirst: jest.fn().mockResolvedValue(rows.run ?? null) },
  };
  return { forTenant: () => db } as any;
}
const user = { sub: "u1" };
const mine = { driver: { id: "d1" }, run: { id: "r1", driverId: "d1", status: "IN_PROGRESS" } };

describe("resolveDriverRunLink (moved from create(), B309)", () => {
  it("returns null and reads nothing when no run or stop is named", async () => {
    const prisma = prismaWith({});
    expect(await resolveDriverRunLink(prisma, {}, user)).toBeNull();
    expect(prisma.forTenant().driver.findFirst).not.toHaveBeenCalled();
  });

  it("links the driver's own active run", async () => {
    expect(await resolveDriverRunLink(prismaWith(mine), { routeRunId: "r1" }, user)).toBe("r1");
  });

  it("resolves the run from a stop when only the stop is named", async () => {
    const prisma = prismaWith({
      ...mine,
      stop: { id: "s1", status: "PENDING", routeRunId: "r1" },
    });
    expect(await resolveDriverRunLink(prisma, { routeRunStopId: "s1" }, user)).toBe("r1");
  });

  it("refuses a missing stop, a stop of another run, another driver's run, a run not in progress, a done stop", async () => {
    await expect(
      resolveDriverRunLink(prismaWith(mine), { routeRunStopId: "nope" }, user),
    ).rejects.toThrow("Stop not found");
    const withStop = prismaWith({
      ...mine,
      stop: { id: "s1", status: "PENDING", routeRunId: "r2" },
    });
    await expect(
      resolveDriverRunLink(withStop, { routeRunId: "r1", routeRunStopId: "s1" }, user),
    ).rejects.toThrow("Stop does not belong to the supplied route run");
    await expect(
      resolveDriverRunLink(
        prismaWith({ ...mine, run: { id: "r1", driverId: "other", status: "IN_PROGRESS" } }),
        { routeRunId: "r1" },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      resolveDriverRunLink(
        prismaWith({ ...mine, run: { id: "r1", driverId: "d1", status: "PLANNED" } }),
        { routeRunId: "r1" },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolveDriverRunLink(
        prismaWith({ ...mine, stop: { id: "s1", status: "COMPLETED", routeRunId: "r1" } }),
        { routeRunStopId: "s1" },
        user,
      ),
    ).rejects.toThrow("Stop is already completed or skipped");
  });
});
