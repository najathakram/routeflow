import { OrderStatus } from "@prisma/client";
import { notifyOrderStatusChange } from "./order-status-notify";

/**
 * W-1060 (SA-1070 R21/R22): the PATCH status path obeys the same record as the Ready press. A SENT
 * `order.ready_for_pickup` row means neither the push nor the READY_FOR_PICKUP email goes again; with no record the
 * email goes and the same row is written. The messaging engine is the module boundary, mocked.
 */
describe("notifyOrderStatusChange: a pickup handover tells the customer once", () => {
  const order = {
    id: "ord-1",
    orderNumber: "ORD-7",
    customerId: "cust-1",
    fulfillPath: "PICKUP",
    status: "CONFIRMED",
  };
  const sentRow = {
    meta: { notice: "SENT", email: "buyer@acme.test" },
    createdAt: new Date("2026-10-31T14:14:00.000Z"),
  };

  function build(record: unknown[], outcomes: unknown = [{ channel: "EMAIL", outcome: "sent" }]) {
    const db = {
      auditLog: { findMany: jest.fn().mockResolvedValue(record) },
      customer: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ email: "buyer@acme.test", orderStatusEmails: true }),
      },
    };
    const prisma = {
      forTenant: () => db,
      getTenantId: () => "t-1",
      auditLog: { create: jest.fn() },
    };
    const notifications = { sendToCustomer: jest.fn().mockResolvedValue(undefined) };
    const messaging = { notifyEvent: jest.fn().mockResolvedValue(outcomes) };
    const run = async () => {
      await notifyOrderStatusChange({ prisma, notifications, messaging } as never, {
        order,
        updated: order,
        status: OrderStatus.OUT_FOR_DELIVERY,
        userSub: "op-1",
      });
      await new Promise((r) => setImmediate(r)); // the fire-and-forget send and its row
    };
    return { prisma, notifications, messaging, run };
  }

  it("R21: a SENT row on the record: no push and no email", async () => {
    const h = build([sentRow]);
    await h.run();
    expect(h.messaging.notifyEvent).not.toHaveBeenCalled();
    expect(h.notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("R22: no record: the email goes and the same row is written", async () => {
    const h = build([]);
    await h.run();
    expect(h.messaging.notifyEvent).toHaveBeenCalledTimes(1);
    expect(h.notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t-1",
        userId: "op-1",
        action: "order.ready_for_pickup",
        entityType: "order",
        entityId: "ord-1",
        meta: { notice: "SENT", email: "buyer@acme.test" },
      }),
    });
  });

  it("an engine that answers nothing (a mock or an older engine) writes no row", async () => {
    const h = build([], null);
    await h.run();
    expect(h.messaging.notifyEvent).toHaveBeenCalledTimes(1);
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("an unreadable record answers no record: the email still goes", async () => {
    const h = build([]);
    h.prisma.forTenant() as never as { auditLog: { findMany: jest.Mock } };
    h.prisma.forTenant = () => {
      throw new Error("db down");
    };
    await h.run();
    expect(h.messaging.notifyEvent).toHaveBeenCalledTimes(1);
  });
});
