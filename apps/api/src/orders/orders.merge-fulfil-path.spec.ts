// The merge paths run inside a Postgres advisory lock; these specs exercise the merge CANDIDATES, not
// the lock, so run the critical section inline (same mock as orders.service.b297-merge.spec.ts).
// B1053: fold-math spec — the row guard is passed through (see testing/merge-recheck-passthrough.ts).
jest.mock("./merge-lock-recheck", () =>
  require("./testing/merge-recheck-passthrough").passthrough(),
);
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { FulfillPath } from "@prisma/client";
import {
  assertNoBackdatedMerge,
  effectiveFulfilPath,
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

  it("sameFulfilPathAsWinner: the first path with MORE THAN ONE order folds; the others are left alone", () => {
    const ship = order("s", FulfillPath.SHIP);
    const route = order("r", FulfillPath.ROUTE);
    const route2 = order("r2", FulfillPath.ROUTE);
    const ship2 = order("s2", FulfillPath.SHIP);
    expect(sameFulfilPathAsWinner([ship, route, ship2]).map((o) => o.id)).toEqual(["s", "s2"]);
    expect(sameFulfilPathAsWinner([route, ship, ship2]).map((o) => o.id)).toEqual(["s", "s2"]);
    // [SHIP newest, ROUTE, ROUTE]: the ROUTE pair still merges, the SHIP order is untouched
    expect(sameFulfilPathAsWinner([ship, route, route2]).map((o) => o.id)).toEqual(["r", "r2"]);
    // no path holds two: just the winner (a no-op fold)
    expect(sameFulfilPathAsWinner([ship, route]).map((o) => o.id)).toEqual(["s"]);
    expect(sameFulfilPathAsWinner([route]).map((o) => o.id)).toEqual(["r"]);
    expect(sameFulfilPathAsWinner([])).toEqual([]);
  });

  it("M2: with a focus order, exactly the focus order's path group, never another path's pair", () => {
    const ship = order("s", FulfillPath.SHIP);
    const route = order("r", FulfillPath.ROUTE);
    const route2 = order("r2", FulfillPath.ROUTE);
    // the new SHIP order is alone on its path: it comes back alone, the ROUTE pair is left for the sweep
    expect(sameFulfilPathAsWinner([ship, route, route2], "s").map((o) => o.id)).toEqual(["s"]);
    expect(sameFulfilPathAsWinner([ship, route, route2], "r2").map((o) => o.id)).toEqual([
      "r",
      "r2",
    ]);
    // a focus that is not a candidate (skipAutoMerge, shipped): fold nothing for this caller
    expect(sameFulfilPathAsWinner([route, route2], "gone")).toEqual([]);
  });

  it("mergeCandidateWhere adds the path only when one is given", () => {
    expect(mergeCandidateWhere(FulfillPath.SHIP)).toEqual({ fulfillPath: "SHIP" });
    expect(mergeCandidateWhere(undefined)).toEqual({});
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

  it("the sweep: [SHIP newest, ROUTE, ROUTE] still merges the ROUTE pair and never touches the SHIP order", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("ship-1", FulfillPath.SHIP, true),
      order("route-2", FulfillPath.ROUTE),
      order("route-1", FulfillPath.ROUTE, true),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    const creates = h.prisma.orderItem.create.mock.calls.map((c: any) => c[0].data.orderId);
    expect(creates).toEqual(["route-2"]); // folded into the ROUTE winner; ship-1's line went nowhere
  });

  it("M2: a post-create sweep with the new order alone on its path folds nothing and returns THAT order", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("ship-new", FulfillPath.SHIP, true),
      order("route-2", FulfillPath.ROUTE),
      order("route-1", FulfillPath.ROUTE, true),
    ]);
    const out = await h.service.mergeAllPendingForCustomer("cust-1", { focusOrderId: "ship-new" });
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled(); // the ROUTE pair waits for the hourly sweep
    expect(out).toMatchObject({ id: "ship-new" }); // never route-2 posing as "the created order"
  });

  it("M2: a post-create sweep whose new order is not a candidate returns null (caller keeps its order)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("route-2", FulfillPath.ROUTE),
      order("route-1", FulfillPath.ROUTE, true),
    ]);
    const out = await h.service.mergeAllPendingForCustomer("cust-1", { focusOrderId: "ship-new" });
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("two SHIP orders (a ship-only business's standing order + an earlier one) DO merge", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("ship-2", FulfillPath.SHIP),
      order("ship-1", FulfillPath.SHIP, true),
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

  it("ship-mode tenant, stored ROUTE customer, explicit ROUTE: the candidate search runs on SHIP (the ONE resolver)", async () => {
    (h.service as any).featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("ship") };
    h.prisma.order.findFirst.mockResolvedValue(null);
    h.prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
    await h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs: { explicit: "ROUTE" } });
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ fulfillPath: "SHIP" });
    // a buyer cart in the same tenant: the portal default
    await h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs: { audience: "buyer" } });
    expect(h.prisma.order.findFirst.mock.calls[1][0].where).toMatchObject({ fulfillPath: "SHIP" });
  });

  it("an unset tenant is byte-identical: the search follows the customer's stored path", async () => {
    (h.service as any).featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("unset") };
    h.prisma.order.findFirst.mockResolvedValue(null);
    h.prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
    await h.service.findActiveOrder("cust-1", { forMerge: true, mergeAs: {} });
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ fulfillPath: "ROUTE" });
  });

  it("the backdated-order refusal looks for the same merge target (same path only)", async () => {
    h.prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
    h.prisma.order.findFirst.mockResolvedValue({ id: "open-1" });
    await expect(
      assertNoBackdatedMerge(h.service as any, "cust-1", FulfillPath.SHIP),
    ).rejects.toThrow(/open order/);
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ fulfillPath: "SHIP" });
    h.prisma.order.findFirst.mockResolvedValue(null);
    await expect(assertNoBackdatedMerge(h.service as any, "cust-1")).resolves.toBeUndefined();
  });

  it("X1: an already-shipped order is NEVER merged away (a SHIP-into-SHIP fold would delete it and its shippedAt)", async () => {
    const shipped = {
      ...order("ship-1", FulfillPath.SHIP, true),
      shippedAt: new Date("2026-10-01"),
    };
    h.prisma.order.findMany.mockResolvedValue([order("ship-2", FulfillPath.SHIP), shipped]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();

    h.prisma.order.findMany.mockResolvedValue([order("ship-3", FulfillPath.SHIP, true), shipped]);
    await h.service.forceConsolidateCustomer("cust-1");
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(h.prisma.order.delete).not.toHaveBeenCalled();
  });

  it("X1: the merge-target search excludes shipped orders", async () => {
    h.prisma.order.findFirst.mockResolvedValue(null);
    await h.service.findActiveOrder("cust-1", { forMerge: true });
    expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({ shippedAt: null });
  });
});
