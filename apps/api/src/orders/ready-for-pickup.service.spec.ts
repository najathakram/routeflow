jest.mock("./orders.service", () => ({ OrdersService: class OrdersService {} }));

import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { NotificationEvent } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { MessagingService } from "../messaging/messaging.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "./orders.service";
import { ReadyForPickupService } from "./ready-for-pickup.service";

/** W-1043 (SA-1062 MUST 15-19): rows R14-R19. The messaging engine is the module boundary, mocked. */
describe("ReadyForPickupService.markReady", () => {
  const user = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
  const baseOrder = {
    id: "ord-1",
    orderNumber: "ORD-7",
    customerId: "cust-1",
    status: "CONFIRMED",
    fulfillPath: "PICKUP",
    counterSale: false,
  };
  const goodCustomer = {
    businessName: "Acme Co",
    email: "buyer@acme.test",
    orderStatusEmails: true,
  };

  async function build(
    order: Record<string, unknown> = baseOrder,
    customer: Record<string, unknown> | null = goodCustomer,
    outcomes: unknown[] = [{ channel: "EMAIL", outcome: "sent" }],
    address: Record<string, string | null> | null = {
      addressLine1: "12 Main St",
      city: "Springfield",
      state: "NY",
      zip: "12345",
    },
  ) {
    const orders = {
      findOneOrThrow: jest.fn().mockResolvedValue(order),
      changeStatus: jest.fn().mockResolvedValue({ ...order, status: "OUT_FOR_DELIVERY" }),
    };
    const db = {
      customer: { findFirst: jest.fn().mockResolvedValue(customer) },
      systemConfig: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      forTenant: () => db,
      getTenantId: () => "t-1",
      tenantConfig: { findUnique: jest.fn().mockResolvedValue(address) },
    };
    const messaging = { notify: jest.fn().mockResolvedValue(outcomes) };
    const notifications = { sendToCustomer: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReadyForPickupService,
        { provide: OrdersService, useValue: orders },
        { provide: PrismaService, useValue: prisma },
        { provide: MessagingService, useValue: messaging },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    return {
      service: moduleRef.get(ReadyForPickupService),
      orders,
      messaging,
      notifications,
      audit,
    };
  }

  it("R14: CONFIRMED with an email on file: SENT, one Ready email, no confirmed email", async () => {
    const h = await build();
    await expect(h.service.markReady("ord-1", user)).resolves.toEqual({
      notice: "SENT",
      email: "buyer@acme.test",
    });
    expect(h.orders.changeStatus).toHaveBeenCalledTimes(1);
    expect(h.orders.changeStatus).toHaveBeenCalledWith(
      "ord-1",
      { status: "OUT_FOR_DELIVERY" },
      user,
      { silent: true },
    );
    expect(h.messaging.notify).toHaveBeenCalledTimes(1);
    expect(h.messaging.notify).toHaveBeenCalledWith(
      NotificationEvent.READY_FOR_PICKUP,
      expect.objectContaining({ customerId: "cust-1", senderId: "op-1" }),
    );
  });

  it("R15: PENDING goes to CONFIRMED silently, then Ready: one email, never the confirmed one", async () => {
    const h = await build({ ...baseOrder, status: "PENDING" });
    const res = await h.service.markReady("ord-1", user);
    expect(res).toEqual({ notice: "SENT", email: "buyer@acme.test" });
    expect(h.orders.changeStatus.mock.calls.map((c) => [c[1].status, c[3]])).toEqual([
      ["CONFIRMED", { silent: true }],
      ["OUT_FOR_DELIVERY", { silent: true }],
    ]);
    expect(h.messaging.notify).toHaveBeenCalledTimes(1);
    expect(h.messaging.notify.mock.calls[0][0]).toBe(NotificationEvent.READY_FOR_PICKUP);
  });

  it("the Ready push still fires, in pickup wording", async () => {
    const h = await build();
    await h.service.markReady("ord-1", user);
    expect(h.notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    const [customerId, title, body] = h.notifications.sendToCustomer.mock.calls[0];
    expect(customerId).toBe("cust-1");
    expect(`${title} ${body}`).toMatch(/ready for pickup/i);
  });

  describe("R16: each way the customer is not told, the status still changed", () => {
    it("no email on file: NO_EMAIL", async () => {
      const h = await build(baseOrder, { ...goodCustomer, email: null }, [
        { channel: "EMAIL", outcome: "skipped", reason: "NO_CONTACT" },
      ]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "NO_EMAIL" });
      expect(h.orders.changeStatus).toHaveBeenCalledTimes(1);
    });
    it("a walk-in (no email, order emails off) reads NO_EMAIL, not opted out", async () => {
      const h = await build(baseOrder, { ...goodCustomer, email: null, orderStatusEmails: false }, [
        { channel: "EMAIL", outcome: "skipped", reason: "OPTED_OUT" },
      ]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "NO_EMAIL" });
    });
    it("customer turned off order emails: OPTED_OUT", async () => {
      const h = await build(baseOrder, { ...goodCustomer, orderStatusEmails: false }, [
        { channel: "EMAIL", outcome: "skipped", reason: "OPTED_OUT" },
      ]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "OPTED_OUT" });
    });
    it("the business switched the event off (no email rule ran): OFF", async () => {
      const h = await build(baseOrder, goodCustomer, []);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "OFF" });
    });
    it("the send fails: FAILED", async () => {
      const h = await build(baseOrder, goodCustomer, [
        { channel: "EMAIL", outcome: "failed", reason: "SEND_FAILED" },
      ]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "FAILED" });
    });
    it("the engine throws: FAILED, and the step still answers", async () => {
      const h = await build();
      h.messaging.notify.mockRejectedValue(new Error("smtp down"));
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ notice: "FAILED" });
      expect(h.orders.changeStatus).toHaveBeenCalledTimes(1);
    });
    it("a hung email reads FAILED after the timeout, not a hung request", async () => {
      jest.useFakeTimers();
      try {
        const h = await build();
        h.messaging.notify.mockReturnValue(new Promise(() => {}));
        const pending = h.service.markReady("ord-1", user);
        await jest.advanceTimersByTimeAsync(60_000);
        await expect(pending).resolves.toEqual({ notice: "FAILED" });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it("R17: a repeat press at OUT_FOR_DELIVERY answers alreadyReady and sends nothing", async () => {
    const h = await build({ ...baseOrder, status: "OUT_FOR_DELIVERY" });
    await expect(h.service.markReady("ord-1", user)).resolves.toEqual({ alreadyReady: true });
    expect(h.orders.changeStatus).not.toHaveBeenCalled();
    expect(h.messaging.notify).not.toHaveBeenCalled();
    expect(h.notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  describe("R18: refused with ORDER_NOT_READYABLE (409), nothing moves", () => {
    it.each([
      ["a counter sale order", { counterSale: true }],
      ["a ROUTE order", { fulfillPath: "ROUTE" }],
      ["a SHIP order", { fulfillPath: "SHIP" }],
      ["a DELIVERED order", { status: "DELIVERED" }],
      ["a CANCELLED order", { status: "CANCELLED" }],
      ["a DRAFT order", { status: "DRAFT" }],
    ])("%s", async (_label, patch) => {
      const h = await build({ ...baseOrder, ...patch });
      const err = await h.service.markReady("ord-1", user).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "ORDER_NOT_READYABLE",
      });
      expect(h.orders.changeStatus).not.toHaveBeenCalled();
      expect(h.messaging.notify).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });
  });

  it("a refused status step (credit gate) leaves nothing sent and nothing audited", async () => {
    const h = await build();
    h.orders.changeStatus.mockRejectedValue(new ConflictException("over limit"));
    await expect(h.service.markReady("ord-1", user)).rejects.toBeInstanceOf(ConflictException);
    expect(h.messaging.notify).not.toHaveBeenCalled();
    expect(h.notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("R19: the email carries the business address; none on file leaves it blank", async () => {
    const withAddress = await build();
    await withAddress.service.markReady("ord-1", user);
    expect(withAddress.messaging.notify.mock.calls[0][1].vars).toMatchObject({
      orderNumber: "ORD-7",
      customerName: "Acme Co",
      pickupLine: " Pick up at 12 Main St, Springfield, NY 12345.",
    });
    const none = await build(baseOrder, goodCustomer, undefined, null);
    await none.service.markReady("ord-1", user);
    expect(none.messaging.notify.mock.calls[0][1].vars.pickupLine).toBe("");
  });

  it("writes the order.ready_for_pickup audit row carrying the notice", async () => {
    const h = await build();
    await h.service.markReady("ord-1", user);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-1",
        userId: "op-1",
        action: "order.ready_for_pickup",
        entityId: "ord-1",
        meta: expect.objectContaining({ notice: "SENT" }),
      }),
    );
  });
});
