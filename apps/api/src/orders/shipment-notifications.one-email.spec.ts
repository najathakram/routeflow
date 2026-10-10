/**
 * F4 server pin: tracking set BEFORE the ship action (web "Ship with tracking": shipment PATCH first,
 * then the status call) yields ONE customer email, ORDER_SHIPPED carrying the tracking, and no
 * SHIPMENT_TRACKING_ADDED. Tracking added LATER, on an already-shipped order, still sends exactly one
 * tracking email. Same harness shape as shipment-notifications.flow.spec.ts.
 */
import { updateShipmentImpl } from "./order-lifecycle";
import { notifyOrderShipped } from "./shipment-notifications";

const flush = () => new Promise<void>((r) => setImmediate(r));
const operator = { sub: "user-op", role: "OPERATOR" } as never;

function harness(order: Record<string, unknown>) {
  // a stateful stand-in for the one marker column: the first claim wins
  let notified = false;
  const db = {
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({ id: "ord-1" }),
      updateMany: jest.fn().mockImplementation(async () => {
        if (notified) return { count: 0 };
        notified = true;
        return { count: 1 };
      }),
    },
    invoice: { updateMany: jest.fn() },
  };
  const messaging = {
    customisedChannels: jest.fn().mockResolvedValue([]),
    enabledChannels: jest.fn().mockResolvedValue(["EMAIL"]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const deps = { prisma: { forTenant: () => db }, messaging } as never;
  return { db, messaging, deps };
}

const base = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  fulfillPath: "SHIP",
  shippedAt: null,
  shippingTrackingNumber: null,
};
const events = (m: { notifyEvent: jest.Mock }) => m.notifyEvent.mock.calls.map((c) => c[0]);

describe("one shipped email when tracking is set with the ship action (F4)", () => {
  it("tracking saved on the CONFIRMED order, then shipped: exactly one ORDER_SHIPPED, with the tracking", async () => {
    const h = harness({ ...base, status: "CONFIRMED" });
    // 1. shipment PATCH on a not-yet-shipped order: no email, marker untouched
    await updateShipmentImpl(
      h.deps,
      "ord-1",
      { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
      operator,
    );
    await flush();
    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    // 2. the status call reads the order WITH the tracking and ships it
    await notifyOrderShipped(
      h.deps,
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        shippingCarrier: "UPS",
        shippingTrackingNumber: "1Z999",
      },
      "user-op",
    );
    expect(events(h.messaging)).toEqual(["ORDER_SHIPPED"]);
    const vars = h.messaging.notifyEvent.mock.calls[0][1].vars;
    expect(vars.trackingLine).toContain("Tracking: 1Z999");
    // 3. a later save of the same tracking on the now-shipped order finds the marker taken: no second email
    h.db.order.findFirst.mockResolvedValue({ ...base, status: "OUT_FOR_DELIVERY" });
    await updateShipmentImpl(
      h.deps,
      "ord-1",
      { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
      operator,
    );
    await flush();
    expect(events(h.messaging)).toEqual(["ORDER_SHIPPED"]);
  });

  it("'Skip, ship now' then tracking added LATER: ORDER_SHIPPED, then exactly one tracking email (unchanged)", async () => {
    const h = harness({ ...base, status: "OUT_FOR_DELIVERY" });
    await notifyOrderShipped(
      h.deps,
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        shippingCarrier: null,
        shippingTrackingNumber: null,
      },
      "user-op",
    );
    await updateShipmentImpl(
      h.deps,
      "ord-1",
      { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
      operator,
    );
    await flush();
    expect(events(h.messaging)).toEqual(["ORDER_SHIPPED", "SHIPMENT_TRACKING_ADDED"]);
  });
});
