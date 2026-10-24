jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  // the sweep's customer lock: run the body (the lock itself is not under test here)
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Logger } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/**
 * W-762 / SA-918 §2: the hourly sweep SKIPS a customer whose merge group has a discounted order (one log line naming
 * DISCOUNTED) and CONTINUES with the rest. It must never abort the sweep (open B324: one un-mergeable customer aborts the
 * whole run), so the guard returns "nothing merged", never an error, on the automatic path.
 */
const order = (id: string, discountAmount: number) => ({
  id,
  discountAmount,
  updatedAt: new Date("2026-10-20T00:00:00.000Z"),
  fulfillPath: null,
  shipmentId: null,
  lineItems: [{ id: `${id}-l`, productId: "p1", status: "PENDING", qty: 1 }],
});

describe("W-762: the hourly sweep skips a discounted customer and continues", () => {
  it("the discounted customer is skipped by the REAL merge guard (logged), the next customer still merges", async () => {
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const prisma = {
      forTenant: () => ({
        order: {
          groupBy: jest
            .fn()
            .mockResolvedValueOnce([
              { customerId: "c-discounted", tenantId: "t1", _count: { _all: 2 } },
              { customerId: "c-plain", tenantId: "t1", _count: { _all: 2 } },
            ])
            .mockResolvedValueOnce([]), // no null-tenant rows
          findMany: jest.fn().mockResolvedValue([order("w", 0), order("l", 5)]),
        },
      }),
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: "t1", status: "ACTIVE" }]) },
    };
    const svc: any = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      tenantCtx: { run: (_t: string, fn: () => unknown) => fn() },
      logger: new Logger("OrdersService"),
    });
    const real = OrdersService.prototype.mergeAllPendingForCustomer;
    const merge = jest.spyOn(svc, "mergeAllPendingForCustomer").mockImplementation(function (
      this: any,
      customerId: any,
      ...rest: any[]
    ) {
      return customerId === "c-discounted"
        ? real.call(svc, customerId, ...rest)
        : Promise.resolve({ id: "winner-plain" });
    });

    const result = await svc.sweepAllPendingOrders();

    expect(merge).toHaveBeenCalledTimes(2);
    expect(await merge.mock.results[0].value).toBeNull(); // the guard's skip, not a throw
    expect(result.merged).toBe(1); // the plain customer still merged
    expect(log.mock.calls.some((c) => /c-discounted \(DISCOUNTED\)/.test(String(c[0])))).toBe(true);
    log.mockRestore();
  });
});
