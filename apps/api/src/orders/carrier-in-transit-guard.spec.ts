import {
  assertNoCarrierInTransit,
  carrierInTransitConflict,
  carrierInTransitCount,
} from "./carrier-in-transit-guard";

const db = (count: number) => ({ order: { count: jest.fn().mockResolvedValue(count) } });

describe("carrierInTransitCount (BO-04: the non-throwing form of the one rule)", () => {
  it.each([
    ["unset", "ship"],
    ["delivery", "both"],
    ["pickup", "pickup_ship"],
    ["ship", "unset"],
    ["both", "delivery"],
  ])(
    "%s -> %s crosses the ship boundary: counts open SHIP orders already shipped",
    async (from, to) => {
      const d = db(3);
      await expect(carrierInTransitCount(d, "t1", from, to)).resolves.toBe(3);
      expect(d.order.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tenantId: "t1",
          fulfillPath: "SHIP",
          shippedAt: { not: null },
        }),
      });
    },
  );

  it.each([
    ["ship", "both"],
    ["ship", "pickup_ship"],
    ["delivery", "pickup"],
    ["unset", "delivery"],
  ])("%s -> %s stays on one side: 0, and no query", async (from, to) => {
    const d = db(5);
    await expect(carrierInTransitCount(d, "t1", from, to)).resolves.toBe(0);
    expect(d.order.count).not.toHaveBeenCalled();
  });
});

describe("assertNoCarrierInTransit wraps the count", () => {
  it("throws the 409 with the count and the Settings message when orders are with the carrier", async () => {
    const err = await assertNoCarrierInTransit(db(2), "t1", "unset", "ship").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual(carrierInTransitConflict(2).getResponse());
    expect(err.getResponse()).toMatchObject({
      statusCode: 409,
      code: "FULFILMENT_CARRIER_IN_TRANSIT",
      count: 2,
      message:
        "Orders are with the carrier right now. Change the delivery method once they are delivered.",
    });
  });

  it("resolves when none are in transit or the change keeps the billing moment", async () => {
    await expect(assertNoCarrierInTransit(db(0), "t1", "unset", "ship")).resolves.toBeUndefined();
    await expect(assertNoCarrierInTransit(db(9), "t1", "ship", "both")).resolves.toBeUndefined();
  });
});
