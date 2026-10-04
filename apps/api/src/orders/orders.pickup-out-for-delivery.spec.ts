import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";

/**
 * SA-655: an OUT_FOR_DELIVERY change on a PICKUP order must not speak of a driver or of delivery. A
 * counter order is handed over at the till; the push says it is ready for pickup and the messaging
 * matrix's driver-named template ("out for delivery today with {{driverName}}") is not sent at all.
 * ROUTE and SHIP orders are untouched (pinned in orders.service.spec.ts).
 */
describe("OrdersService.changeStatus — OUT_FOR_DELIVERY on a PICKUP order", () => {
  const order = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status: "CONFIRMED",
    fulfillPath: "PICKUP",
    routeRunId: null,
    total: 16.47,
    customer: { businessName: "Acme Co" },
  };

  async function run(fulfillPath: string) {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({ ...order, fulfillPath });
    h.prisma.order.update.mockResolvedValue({ ...order, fulfillPath, status: "OUT_FOR_DELIVERY" });
    await h.service.changeStatus(
      "ord-1",
      { status: "OUT_FOR_DELIVERY" as never },
      operatorPayload as never,
    );
    return {
      push: h.module.get(NotificationsService) as unknown as { sendToCustomer: jest.Mock },
      messaging: h.module.get(MessagingService) as unknown as { notifyEvent: jest.Mock },
    };
  }

  it("pushes pickup wording and never names a driver", async () => {
    const { push } = await run("PICKUP");
    const [, title, body] = push.sendToCustomer.mock.calls[0];
    expect(`${title} ${body}`).toMatch(/ready for pickup/i);
    expect(`${title} ${body}`).not.toMatch(/driver|on its way|out for delivery/i);
  });

  it("sends no OUT_FOR_DELIVERY message through the messaging matrix", async () => {
    const { messaging } = await run("PICKUP");
    expect(messaging.notifyEvent).not.toHaveBeenCalledWith("OUT_FOR_DELIVERY", expect.anything());
  });

  it("a ROUTE order is unchanged: 'on its way' push and the driver-named message", async () => {
    const { push, messaging } = await run("ROUTE");
    expect(push.sendToCustomer.mock.calls[0][2]).toMatch(/on its way/);
    expect(messaging.notifyEvent).toHaveBeenCalledWith(
      "OUT_FOR_DELIVERY",
      expect.objectContaining({ vars: expect.objectContaining({ driverName: "your driver" }) }),
    );
  });
});
