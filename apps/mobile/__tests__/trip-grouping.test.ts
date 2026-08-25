/**
 * `groupOrdersForTrip` groups the operator's order selection into one
 * delivery stop per distinct customer for the ad-hoc trip builder. This
 * module is a byte-for-byte mirror of `packages/types/trip-grouping.ts` (see
 * that file's header) — these specs pin the same behavior locally so mobile
 * can't silently drift from the shared/API copies.
 */
import { groupOrdersForTrip, type TripGroupableOrder } from "../lib/trip-grouping";

function order(overrides: Partial<TripGroupableOrder> & { id: string }): TripGroupableOrder {
  return {
    orderNumber: null,
    customerId: null,
    customerName: null,
    ...overrides,
  };
}

describe("groupOrdersForTrip — grouping by customer", () => {
  it("puts every order for the same customer into one stop group", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o2", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o3", customerId: "c1", customerName: "Acme Corner Store" }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toEqual({
      customerId: "c1",
      customerName: "Acme Corner Store",
      orderIds: ["o1", "o2", "o3"],
    });
    expect(result.skipped).toEqual([]);
  });

  it("splits orders for different customers into separate stop groups", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o2", customerId: "c2", customerName: "Bay Market" }),
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.customerId)).toEqual(["c1", "c2"]);
  });

  it("preserves first-seen order of customers, not insertion of any other kind", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", customerId: "c2", customerName: "Bay Market" }),
      order({ id: "o2", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o3", customerId: "c2", customerName: "Bay Market" }),
      order({ id: "o4", customerId: "c3", customerName: "Zeller Wholesale" }),
    ]);
    expect(result.groups.map((g) => g.customerId)).toEqual(["c2", "c1", "c3"]);
    // The c2 group keeps o1 and o3 in the order they appeared, even though c1
    // was seen in between.
    expect(result.groups[0].orderIds).toEqual(["o1", "o3"]);
  });

  it("dedupes a repeated order id within the same customer's group", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o1", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o2", customerId: "c1", customerName: "Acme Corner Store" }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].orderIds).toEqual(["o1", "o2"]);
  });

  it("carries a null customerName through instead of substituting a label", () => {
    const result = groupOrdersForTrip([order({ id: "o1", customerId: "c1", customerName: null })]);
    expect(result.groups[0].customerName).toBeNull();
  });
});

describe("groupOrdersForTrip — NO_CUSTOMER skip reason", () => {
  it("skips an order with no customerId instead of grouping it", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", orderNumber: "ORD-1001", customerId: null }),
    ]);
    expect(result.groups).toEqual([]);
    expect(result.skipped).toEqual([
      { orderId: "o1", orderNumber: "ORD-1001", reason: "NO_CUSTOMER" },
    ]);
  });

  it("falls back to a null orderNumber when none is given", () => {
    const result = groupOrdersForTrip([order({ id: "o1", customerId: null })]);
    expect(result.skipped).toEqual([{ orderId: "o1", orderNumber: null, reason: "NO_CUSTOMER" }]);
  });

  it("keeps skipped orders alongside grouped ones without disturbing either list", () => {
    const result = groupOrdersForTrip([
      order({ id: "o1", customerId: "c1", customerName: "Acme Corner Store" }),
      order({ id: "o2", orderNumber: "ORD-2002", customerId: null }),
      order({ id: "o3", customerId: "c1", customerName: "Acme Corner Store" }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].orderIds).toEqual(["o1", "o3"]);
    expect(result.skipped).toEqual([
      { orderId: "o2", orderNumber: "ORD-2002", reason: "NO_CUSTOMER" },
    ]);
  });
});

describe("groupOrdersForTrip — degenerate input", () => {
  it("returns empty groups and skipped for an empty order list", () => {
    expect(groupOrdersForTrip([])).toEqual({ groups: [], skipped: [] });
  });
});
