import { OrderStatus } from "@prisma/client";
import { notifyOrderStatusChange } from "./order-status-notify";

/**
 * W-1286 PR-1 (SA-1202 C7): the order-status email names the order it is about, so its delivery row can be written.
 * The messaging engine is the module boundary, mocked.
 */
describe("notifyOrderStatusChange passes the order to the messaging engine", () => {
  it("the rules-matrix email for CONFIRMED carries entity Order/<id>", async () => {
    const order = {
      id: "ord-1",
      orderNumber: "ORD-7",
      customerId: "cust-1",
      fulfillPath: "DELIVERY",
      status: "PENDING",
    };
    const messaging = { notifyEvent: jest.fn().mockResolvedValue([]) };
    await notifyOrderStatusChange(
      {
        prisma: { forTenant: () => ({}), getTenantId: () => "t-1" },
        notifications: { sendToCustomer: jest.fn().mockResolvedValue(undefined) },
        messaging,
      } as never,
      { order, updated: { total: 10 }, status: OrderStatus.CONFIRMED, userSub: "op-1" },
    );
    expect(messaging.notifyEvent).toHaveBeenCalledTimes(1);
    expect(messaging.notifyEvent.mock.calls[0][1].entity).toEqual({ type: "Order", id: "ord-1" });
  });
});
