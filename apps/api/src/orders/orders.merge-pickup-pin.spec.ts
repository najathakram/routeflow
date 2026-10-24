// The merge paths run inside a Postgres advisory lock; these specs exercise the merge CANDIDATES, not
// the lock, so run the critical section inline (same mock as orders.merge-fulfil-path.spec.ts).
jest.mock("./merge-lock-recheck", () => require("./testing/merge-recheck").pass());
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { FulfillPath } from "@prisma/client";
import { sameFulfilPathAsWinner } from "./merge-candidates";
import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * SA-763r P-1a, the merge pin: a PICKUP order (POS mode) and a ROUTE order of one customer never fold into
 * each other, at every merge entry. One predicate (`sameFulfilPathAsWinner`, merge-candidates.ts).
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

describe("a PICKUP and a ROUTE order of one customer never fold", () => {
  it("sameFulfilPathAsWinner: PICKUP and ROUTE are different groups, whichever is newest", () => {
    const pickup = order("p", FulfillPath.PICKUP);
    const route = order("r", FulfillPath.ROUTE);
    expect(sameFulfilPathAsWinner([pickup, route]).map((o) => o.id)).toEqual(["p"]);
    expect(sameFulfilPathAsWinner([route, pickup]).map((o) => o.id)).toEqual(["r"]);
    // a post-create sweep for the new PICKUP order folds nothing into the ROUTE pair, nor the pair into it
    const route2 = order("r2", FulfillPath.ROUTE);
    expect(sameFulfilPathAsWinner([pickup, route, route2], "p").map((o) => o.id)).toEqual(["p"]);
    expect(sameFulfilPathAsWinner([pickup, route, route2], "r2").map((o) => o.id)).toEqual([
      "r",
      "r2",
    ]);
  });

  it("sameFulfilPathAsWinner: two PICKUP orders still fold together (control)", () => {
    const folded = sameFulfilPathAsWinner([
      order("p2", FulfillPath.PICKUP),
      order("p1", FulfillPath.PICKUP),
    ]);
    expect(folded.map((o) => o.id)).toEqual(["p2", "p1"]);
  });

  describe("OrdersService merge entry points", () => {
    let h: Awaited<ReturnType<typeof buildOrdersService>>;
    beforeEach(async () => {
      h = await buildOrdersService();
      h.prisma.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: null }]);
      h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 10, status: "PENDING" }]);
    });

    it("mergeAllPendingForCustomer: nothing is written, the winner comes back untouched", async () => {
      h.prisma.order.findMany.mockResolvedValue([
        order("pickup-1", FulfillPath.PICKUP),
        order("route-1", FulfillPath.ROUTE, true),
      ]);
      const out = await h.service.mergeAllPendingForCustomer("cust-1");
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
      expect(out).toMatchObject({ id: "pickup-1" });
    });

    it("forceConsolidateCustomer: a ROUTE order never folds into a PICKUP order either", async () => {
      h.prisma.order.findMany.mockResolvedValue([
        order("route-1", FulfillPath.ROUTE),
        order("pickup-1", FulfillPath.PICKUP, true),
      ]);
      await h.service.forceConsolidateCustomer("cust-1");
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
      expect(h.prisma.order.delete).not.toHaveBeenCalled();
    });

    it("the merge-target search for an incoming POS-mode order only looks at PICKUP orders", async () => {
      (h.service as any).featureConfig = {
        getEffectiveMode: jest.fn().mockResolvedValue("delivery"),
      };
      h.prisma.order.findFirst.mockResolvedValue(null);
      h.prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
      await h.service.findActiveOrder("cust-1", {
        forMerge: true,
        mergeAs: { explicit: "PICKUP", audience: "staff", role: "OPERATOR" },
      });
      expect(h.prisma.order.findFirst.mock.calls[0][0].where).toMatchObject({
        fulfillPath: "PICKUP",
      });
    });
  });
});
