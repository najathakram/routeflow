/**
 * Carrier-shipped customer emails, end to end through the real helpers with the data layer and the
 * messaging engine mocked at their boundary (kept out of orders.service.spec.ts, which sits at its
 * size-ratchet cap):
 *   - notifyOrderShipped: ORDER_SHIPPED vs the per-channel keep-my-wording split, the tracking marker;
 *   - updateShipmentImpl: the one-time SHIPMENT_TRACKING_ADDED follow-up.
 */
import { NotFoundException } from "@nestjs/common";
import { updateShipmentImpl } from "./order-lifecycle";
import { notifyOrderShipped } from "./shipment-notifications";

const flush = () => new Promise<void>((r) => setImmediate(r));
const UPS = "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784";
const operator = { sub: "user-op", role: "OPERATOR" } as any;

function harness() {
  const db = {
    order: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    invoice: { updateMany: jest.fn() },
  };
  db.order.update.mockResolvedValue({ id: "ord-1" });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  const messaging = {
    customisedChannels: jest.fn().mockResolvedValue([]),
    enabledChannels: jest.fn().mockResolvedValue(["EMAIL", "PORTAL"]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const deps = { prisma: { forTenant: () => db }, messaging } as any;
  return { db, messaging, deps };
}

const shipOrder = (over: Record<string, unknown> = {}) => ({
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  shippingCarrier: "UPS",
  shippingTrackingNumber: null,
  ...over,
});
const events = (m: { notifyEvent: jest.Mock }) => m.notifyEvent.mock.calls.map((c) => c[0]);

describe("notifyOrderShipped", () => {
  it("default wording: ORDER_SHIPPED only, for every enabled channel, with carrier and an empty trackingLine", async () => {
    const { deps, messaging, db } = harness();

    await notifyOrderShipped(deps, shipOrder(), "user-op");

    expect(events(messaging)).toEqual(["ORDER_SHIPPED"]);
    const [, args] = messaging.notifyEvent.mock.calls[0];
    expect(args).toEqual({
      customerId: "cust-1",
      senderId: "user-op",
      vars: { orderNumber: "ORD-123", carrier: "UPS", trackingLine: "" },
    });
    expect(args.exceptChannels).toBeUndefined();
    expect(db.order.updateMany).not.toHaveBeenCalled(); // no tracking => marker stays free
  });

  it("no carrier set: 'the carrier'", async () => {
    const { deps, messaging } = harness();
    await notifyOrderShipped(deps, shipOrder({ shippingCarrier: null }), null);
    expect(messaging.notifyEvent.mock.calls[0][1].vars.carrier).toBe("the carrier");
  });

  it("shipped WITH tracking: the email carries it and the one-time marker is consumed", async () => {
    const { deps, messaging, db } = harness();

    await notifyOrderShipped(
      deps,
      shipOrder({ shippingTrackingNumber: "1Z999AA10123456784" }),
      "u",
    );

    expect(messaging.notifyEvent.mock.calls[0][1].vars.trackingLine).toBe(
      ` Tracking: 1Z999AA10123456784 — ${UPS}`,
    );
    expect(db.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", trackingNotifiedAt: null },
      data: { trackingNotifiedAt: expect.any(Date) },
    });
  });

  it("a customised OUT_FOR_DELIVERY channel keeps its wording; every other channel gets ORDER_SHIPPED; no channel gets both", async () => {
    const { deps, messaging } = harness();
    messaging.customisedChannels.mockResolvedValue(["EMAIL"]);

    await notifyOrderShipped(deps, shipOrder({ shippingTrackingNumber: "TRK1" }), "u");

    expect(messaging.customisedChannels).toHaveBeenCalledWith("OUT_FOR_DELIVERY");
    expect(events(messaging)).toEqual(["OUT_FOR_DELIVERY", "ORDER_SHIPPED"]);
    const [, out] = messaging.notifyEvent.mock.calls[0];
    expect(out.channels).toEqual(["EMAIL"]);
    expect(out.vars).toMatchObject({
      orderNumber: "ORD-123",
      driverName: "UPS",
      carrier: "UPS",
      trackingNumber: "TRK1",
    });
    expect(out.vars.trackingLine).toContain("TRK1");
    const [, shipped] = messaging.notifyEvent.mock.calls[1];
    expect(shipped.exceptChannels).toEqual(["EMAIL"]);
    expect(shipped.channels).toBeUndefined();
  });

  it("S2: a channel with 'Order shipped' switched OFF stays off, even if its out-for-delivery wording is customised", async () => {
    const { deps, messaging } = harness();
    messaging.customisedChannels.mockResolvedValue(["EMAIL"]);
    messaging.enabledChannels.mockResolvedValue(["PORTAL"]); // ORDER_SHIPPED is off for EMAIL
    await notifyOrderShipped(deps, shipOrder(), "u");
    expect(events(messaging)).toEqual(["ORDER_SHIPPED"]); // no customised OUT_FOR_DELIVERY on EMAIL
    expect(messaging.notifyEvent.mock.calls[0][1].exceptChannels).toBeUndefined();
  });

  it("never throws: a failing customisation read or send is swallowed", async () => {
    const a = harness();
    a.messaging.customisedChannels.mockRejectedValue(new Error("db down"));
    await expect(notifyOrderShipped(a.deps, shipOrder(), "u")).resolves.toBeUndefined();

    const b = harness();
    b.messaging.notifyEvent.mockRejectedValue(new Error("smtp down"));
    await expect(notifyOrderShipped(b.deps, shipOrder(), "u")).resolves.toBeUndefined();
  });
});

describe("updateShipmentImpl: one-time SHIPMENT_TRACKING_ADDED", () => {
  const shipped = (over: Record<string, unknown> = {}) => ({
    id: "ord-1",
    shippedAt: null,
    status: "OUT_FOR_DELIVERY",
    fulfillPath: "SHIP",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    shippingTrackingNumber: null,
    ...over,
  });
  const setTracking = async (
    h: ReturnType<typeof harness>,
    tracking = "1Z999AA10123456784",
    carrier = "UPS",
  ) => {
    const res = await updateShipmentImpl(
      h.deps,
      "ord-1",
      { shippingCarrier: carrier, shippingTrackingNumber: tracking },
      operator,
    );
    await flush();
    return res;
  };

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "fires exactly once for a SHIP order already %s when tracking goes empty -> set",
    async (status) => {
      const h = harness();
      h.db.order.findFirst.mockResolvedValue(shipped({ status }));

      await setTracking(h);

      expect(h.db.order.updateMany).toHaveBeenCalledWith({
        where: { id: "ord-1", trackingNotifiedAt: null },
        data: { trackingNotifiedAt: expect.any(Date) },
      });
      expect(h.messaging.notifyEvent).toHaveBeenCalledTimes(1);
      expect(h.messaging.notifyEvent).toHaveBeenCalledWith("SHIPMENT_TRACKING_ADDED", {
        customerId: "cust-1",
        senderId: "user-op",
        vars: { orderNumber: "ORD-123", trackingNumber: "1Z999AA10123456784", trackingUrl: UPS },
      });
    },
  );

  it("does not repeat: a lost marker claim (double submit / already told) sends nothing", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped());
    h.db.order.updateMany.mockResolvedValue({ count: 0 });

    await setTracking(h);

    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
  });

  it("a double submit races the marker: only one of two concurrent saves sends", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped());
    h.db.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await Promise.all([setTracking(h), setTracking(h)]);

    expect(h.messaging.notifyEvent).toHaveBeenCalledTimes(1);
  });

  it("an unrecognised carrier falls back to 'via <carrier>' (no dangling dash)", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped());

    await setTracking(h, "ABC123", "Acme Freight");

    expect(h.messaging.notifyEvent.mock.calls[0][1].vars.trackingUrl).toBe("via Acme Freight");
  });

  it.each([
    ["a ROUTE order", { fulfillPath: "ROUTE" }],
    ["an order not yet shipped (CONFIRMED)", { status: "CONFIRMED" }],
    ["an order not yet shipped (PENDING)", { status: "PENDING" }],
    ["a cancelled order", { status: "CANCELLED" }],
    ["a tracking EDIT (set -> changed)", { shippingTrackingNumber: "OLD-TRACKING" }],
  ])("sends nothing for %s", async (_label, over) => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped(over));

    await setTracking(h);

    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it("a carrier-only change (no tracking number) sends nothing", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped());

    await setTracking(h, "", "UPS");

    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
  });

  it("clearing sends nothing, and clear-then-re-add is refused by the already-stamped marker", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(
      shipped({ shippingTrackingNumber: "1Z999AA10123456784" }),
    );
    await setTracking(h, "", "");
    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();

    h.db.order.findFirst.mockResolvedValue(shipped());
    h.db.order.updateMany.mockResolvedValue({ count: 0 }); // marker stamped earlier
    await setTracking(h);
    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
  });

  it("a notification failure never fails the shipment write", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(shipped());
    h.messaging.notifyEvent.mockRejectedValue(new Error("smtp down"));

    await expect(setTracking(h, "1Z")).resolves.toEqual({ id: "ord-1" });
  });

  it("404s a cross-tenant order id with no write and no send", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue(null);

    await expect(
      updateShipmentImpl(h.deps, "ord-foreign", { shippingTrackingNumber: "1Z" } as any, operator),
    ).rejects.toThrow(NotFoundException);
    expect(h.db.order.update).not.toHaveBeenCalled();
    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
  });
});

describe("E-c / L6 / E-b decisions", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isFirstShipment } = require("./shipment-notifications");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assertCarrierOrderNotInTransit } = require("./order-status-invoicing");

  it("E-c: the first ship is a first shipment; an unmark + re-ship (shippedAt kept) is not", () => {
    expect(isFirstShipment({ shippedAt: null })).toBe(true);
    expect(isFirstShipment({ shippedAt: new Date("2026-10-01T00:00:00Z") })).toBe(false);
  });

  const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
  const out = { status: "OUT_FOR_DELIVERY", fulfillPath: "SHIP" };

  it.each(["ship", "both", "pickup_ship"])(
    "L6: a SHIP order out with the carrier of a %s business is refused with the coded 409",
    async (mode) => {
      await expect(assertCarrierOrderNotInTransit(cfg(mode), "t1", out)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_CANCEL" }),
      });
    },
  );

  it("L6: an UNSET-mode business cancels exactly as before (the rule is gated on the billing moment)", async () => {
    await expect(assertCarrierOrderNotInTransit(cfg("unset"), "t1", out)).resolves.toBeUndefined();
    await expect(assertCarrierOrderNotInTransit(undefined, "t1", out)).resolves.toBeUndefined();
  });

  it("L6: PARTIALLY_DELIVERED is in transit too; ROUTE orders and not-yet-shipped orders are untouched", async () => {
    await expect(
      assertCarrierOrderNotInTransit(cfg("ship"), "t1", { ...out, status: "PARTIALLY_DELIVERED" }),
    ).rejects.toBeDefined();
    for (const o of [
      { status: "OUT_FOR_DELIVERY", fulfillPath: "ROUTE" },
      { status: "CONFIRMED", fulfillPath: "SHIP" },
      { status: "PENDING", fulfillPath: "SHIP" },
    ])
      await expect(assertCarrierOrderNotInTransit(cfg("ship"), "t1", o)).resolves.toBeUndefined();
  });

  it("E-b: saving tracking on a CONFIRMED order stamps no shippedAt; on a shipped legacy row it backfills", async () => {
    const h = harness();
    h.db.order.findFirst.mockResolvedValue({
      id: "ord-1",
      shippedAt: null,
      status: "CONFIRMED",
      fulfillPath: "SHIP",
      customerId: "cust-1",
      orderNumber: "ORD-123",
      shippingTrackingNumber: null,
    });
    await updateShipmentImpl(h.deps, "ord-1", { shippingTrackingNumber: "1Z" } as any, operator);
    expect(h.db.order.update.mock.calls[0][0].data.shippedAt).toBeNull();
  });

  it("clearing the tracking keeps the ship date the transition stamped", async () => {
    const h = harness();
    const shippedAt = new Date("2026-10-01T00:00:00Z");
    h.db.order.findFirst.mockResolvedValue({
      id: "ord-1",
      shippedAt,
      status: "OUT_FOR_DELIVERY",
      fulfillPath: "SHIP",
      customerId: "cust-1",
      orderNumber: "ORD-123",
      shippingTrackingNumber: "1Z",
    });
    await updateShipmentImpl(h.deps, "ord-1", { shippingTrackingNumber: "" } as any, operator);
    expect(h.db.order.update.mock.calls[0][0].data.shippedAt).toBe(shippedAt);
  });
});
