// The merge paths run inside a Postgres advisory lock; these specs exercise the merge CANDIDATES, not
// the lock, so run the critical section inline (same mock as orders.service.b297-merge.spec.ts).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { FulfillPath } from "@prisma/client";
import {
  effectiveFulfilPath,
  incomingFulfilPath,
  mergeCandidateWhere,
  sameFulfilPathAsWinner,
} from "./merge-candidates";
import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * A SHIP order never folds into a ROUTE order, at EVERY merge entry (one predicate, `merge-candidates.ts`):
 * `findActiveOrder` (staff create auto-merge, the buyer's active-order fold), `mergeAllPendingForCustomer`
 * (the post-commit sweeps, the standing-order templates, the hourly sweep) and `forceConsolidateCustomer`.
 */
const line = (id: string) => ({
  id,
  productId: "prod-1",
  qty: 2,
  unitPrice: 5,
  subtotal: 10,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  name: null,
  overrideReason: null,
  overriddenBy: null,
  boxes: null,
  pieces: null,
});
const order = (id: string, fulfillPath: FulfillPath, withLine = false) => ({
  id,
  customerId: "cust-1",
  status: "PENDING",
  fulfillPath,
  lineItems: withLine ? [line(`${id}-l`)] : [],
});

describe("merge-candidates (pure)", () => {
  it("effectiveFulfilPath: the order's path, ROUTE when it has none", () => {
    expect(effectiveFulfilPath({ fulfillPath: FulfillPath.SHIP })).toBe("SHIP");
    expect(effectiveFulfilPath({})).toBe("ROUTE");
    expect(effectiveFulfilPath({ fulfillPath: null })).toBe("ROUTE");
  });

  it("sameFulfilPathAsWinner keeps only the winner's path (the first, most recent)", () => {
    const ship = order("s", FulfillPath.SHIP);
    const route = order("r", FulfillPath.ROUTE);
    const ship2 = order("s2", FulfillPath.SHIP);
    expect(sameFulfilPathAsWinner([ship, route, ship2]).map((o) => o.id)).toEqual(["s", "s2"]);
    expect(sameFulfilPathAsWinner([route, ship, ship2]).map((o) => o.id)).toEqual(["r"]);
    expect(sameFulfilPathAsWinner([route]).map((o) => o.id)).toEqual(["r"]);
    expect(sameFulfilPathAsWinner([])).toEqual([]);
  });

  it("mergeCandidateWhere adds the path only when one is given", () => {
    expect(mergeCandidateWhere(FulfillPath.SHIP)).toEqual({ fulfillPath: "SHIP" });
    expect(mergeCandidateWhere(undefined)).toEqual({});
  });

  it("incomingFulfilPath: an explicit path wins, else the customer's stored path, else ROUTE", async () => {
    const prisma = (stored: unknown) =>
      ({
        forTenant: () => ({ customer: { findFirst: jest.fn().mockResolvedValue(stored) } }),
      }) as any;
    expect(await incomingFulfilPath(prisma({ fulfillPath: "ROUTE" }), "c", FulfillPath.SHIP)).toBe(
      "SHIP",
    );
    expect(await incomingFulfilPath(prisma({ fulfillPath: "SHIP" }), "c")).toBe("SHIP");
    expect(await incomingFulfilPath(prisma({ fulfillPath: "ROUTE" }), "c")).toBe("ROUTE");
    expect(await incomingFulfilPath(prisma(null), "c")).toBe("ROUTE");
  });
});

describe("OrdersService merge entry points", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: null }]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 10, status: "PENDING" }]);
  });

  it("mergeAllPendingForCustomer: a SHIP order never folds into a ROUTE order (nothing written)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("ship-1", FulfillPath.SHIP),
      order("route-1", FulfillPath.ROUTE, true),
    ]);
    const out = await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: "ship-1" }); // the winner comes back untouched
  });

  it("mergeAllPendingForCustomer: same path still folds exactly as before (control)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("route-2", FulfillPath.ROUTE),
      order("route-1", FulfillPath.ROUTE, true),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.prisma.orderItem.create).toHaveBeenCalled();
  });

  it("forceConsolidateCustomer: a SHIP order never folds into a ROUTE order either", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("route-1", FulfillPath.ROUTE),
      order("ship-1", FulfillPath.SHIP, true),
    ]);
    await h.service.forceConsolidateCustomer("cust-1");
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
  });

  it("findActiveOrder with mergeAs narrows the search to the incoming path: explicit, else the stored one", async () => {
    h.prisma.order.findFirst.mockResolvedValue(null);
    h.prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
    // an explicit SHIP request: only SHIP orders are merge targets
    await h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs: { explicit: "SHIP" } });
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ fulfillPath: "SHIP" });
    // nothing explicit (a buyer cart): the customer's stored path
    await h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs: {} });
    expect(h.prisma.order.findFirst.mock.calls[1][0].where).toMatchObject({ fulfillPath: "ROUTE" });
    // no mergeAs (a display read): no path filter at all
    await h.service.findActiveOrder("cust-1");
    expect(h.prisma.order.findFirst.mock.calls[2][0].where).not.toHaveProperty("fulfillPath");
  });
});
