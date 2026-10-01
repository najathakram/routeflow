import { ForbiddenException } from "@nestjs/common";
import { RoutesService } from "./routes.service";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));

/**
 * #2514 (2): completeStop / completeWithPayment answered a non-IN_PROGRESS run with
 * "Cannot complete a stop on a run that is not in progress (current status: …)" BEFORE the B72
 * driver-ownership check — so a driver with no claim on the run could read its status. Order is
 * now: run 404 → stop 404 → ownership 403 → run-status 403 → stop state (the #2415 ordering).
 */
describe("RoutesService — run-status check after ownership (#2514)", () => {
  const build = (runStatus: string, runDriverId: string) => {
    const db = {
      routeRun: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "run-1", driverId: runDriverId, status: runStatus }),
      },
      routeRunStop: {
        findFirst: jest.fn().mockResolvedValue({ id: "stop-1", status: "PENDING", orders: [] }),
      },
      driver: { findFirst: jest.fn().mockResolvedValue({ id: "drv-mine" }) },
    };
    const svc: any = Object.assign(Object.create(RoutesService.prototype), {
      prisma: { forTenant: () => db },
    });
    return svc;
  };
  const driver = { sub: "u-drv", role: "DRIVER", tenantId: "t1" } as any;

  it.each(["completeStop", "completeWithPayment"])(
    "%s: a non-owner driver on a COMPLETED run gets the bare 403, never the run's status",
    async (method) => {
      const svc = build("COMPLETED", "drv-someone-else");
      const err = await svc[method]("run-1", "stop-1", {}, driver).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toBe("You do not have access to this route run");
      expect((err as Error).message).not.toMatch(/COMPLETED|not in progress/);
    },
  );

  it.each(["completeStop", "completeWithPayment"])(
    "%s: the run's OWNER still gets the run-status 403 (control)",
    async (method) => {
      const svc = build("COMPLETED", "drv-mine");
      await expect(svc[method]("run-1", "stop-1", {}, driver)).rejects.toThrow(/not in progress/);
    },
  );
});
