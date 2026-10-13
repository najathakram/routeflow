import { FulfillPath } from "@prisma/client";
import { DISPATCH_PATH_WHERE, isPickupFulfilment } from "./dispatch-path-where";

/** SA-763r P-1a, the dispatch pin: the two filter forms every dispatch reader takes from one module. */
describe("DISPATCH_PATH_WHERE", () => {
  it("the route form leaves PICKUP out and keeps ROUTE and SHIP in", () => {
    expect(DISPATCH_PATH_WHERE.route).toEqual({ not: FulfillPath.PICKUP });
  });

  it("the trips form leaves SHIP and PICKUP out: only ROUTE rides a trip", () => {
    expect(DISPATCH_PATH_WHERE.trips).toEqual({ notIn: [FulfillPath.SHIP, FulfillPath.PICKUP] });
    expect(DISPATCH_PATH_WHERE.trips.notIn).not.toContain(FulfillPath.ROUTE);
  });

  it("isPickupFulfilment is the in-memory twin: true for PICKUP only", () => {
    expect(isPickupFulfilment({ fulfillPath: FulfillPath.PICKUP })).toBe(true);
    expect(isPickupFulfilment({ fulfillPath: FulfillPath.ROUTE })).toBe(false);
    expect(isPickupFulfilment({ fulfillPath: FulfillPath.SHIP })).toBe(false);
    expect(isPickupFulfilment({ fulfillPath: null })).toBe(false);
    expect(isPickupFulfilment({})).toBe(false);
  });
});
