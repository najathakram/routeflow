jest.mock("./orders.service", () => ({ OrdersService: class OrdersService {} }));

import { ConflictException, NotFoundException } from "@nestjs/common";
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
    /** What the order.ready_for_pickup audit rows already say, newest first (SA-1070 rule 2). */
    record: Array<{ meta: Record<string, unknown>; createdAt: Date }> = [],
  ) {
    const orders = {
      findOneOrThrow: jest.fn().mockResolvedValue(order),
      changeStatus: jest.fn().mockResolvedValue({ ...order, status: "OUT_FOR_DELIVERY" }),
    };
    const db = {
      customer: { findFirst: jest.fn().mockResolvedValue(customer) },
      systemConfig: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue(record) },
    };
    const prisma = {
      forTenant: () => db,
      getTenantId: () => "t-1",
      tenantConfig: { findUnique: jest.fn().mockResolvedValue(address) },
    };
    const messaging = {
      notify: jest.fn().mockResolvedValue(outcomes),
      enabledChannels: jest.fn().mockResolvedValue(["EMAIL"]),
    };
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
      db,
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

  describe("SA-1070: the customer is told once (W-1060, F13)", () => {
    const at = new Date("2026-10-31T14:14:00.000Z");
    const sentRow = { meta: { notice: "SENT", email: "buyer@acme.test" }, createdAt: at };

    it("R20: a SENT row on the record: the status moves, no email, no push, no new row, toldOnce", async () => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [sentRow]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({
        toldOnce: true,
        email: "buyer@acme.test",
        at: at.toISOString(),
      });
      expect(h.orders.changeStatus).toHaveBeenCalledTimes(1);
      expect(h.messaging.notify).not.toHaveBeenCalled();
      expect(h.notifications.sendToCustomer).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it.each([
      ["FAILED", { notice: "FAILED" }],
      ["NO_EMAIL", { notice: "NO_EMAIL" }],
      ["OPTED_OUT", { notice: "OPTED_OUT" }],
      ["OFF", { notice: "OFF" }],
    ])("R24: only SENT latches: after %s the next press tries again", async (_n, meta) => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [
        { meta, createdAt: at },
      ]);
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({
        notice: "SENT",
        email: "buyer@acme.test",
      });
      expect(h.messaging.notify).toHaveBeenCalledTimes(1);
    });

    it("R25: a record that cannot be read answers no record: one email, the move never fails", async () => {
      const h = await build();
      h.db.auditLog.findMany.mockRejectedValue(new Error("db down"));
      await expect(h.service.markReady("ord-1", user)).resolves.toEqual({
        notice: "SENT",
        email: "buyer@acme.test",
      });
      expect(h.orders.changeStatus).toHaveBeenCalledTimes(1);
      expect(h.messaging.notify).toHaveBeenCalledTimes(1);
    });

    it("the SENT row wins over a later failed resend", async () => {
      const failed = {
        meta: { notice: "FAILED", resend: true },
        createdAt: new Date(at.getTime() + 60_000),
      };
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [failed, sentRow]);
      await expect(h.service.markReady("ord-1", user)).resolves.toMatchObject({ toldOnce: true });
      expect(h.messaging.notify).not.toHaveBeenCalled();
    });

    it("R28: Send again at OUT_FOR_DELIVERY emails once, moves nothing, writes a resend row", async () => {
      const h = await build(
        { ...baseOrder, status: "OUT_FOR_DELIVERY" },
        goodCustomer,
        undefined,
        undefined,
        [sentRow],
      );
      await expect(h.service.markReady("ord-1", user, { resend: true })).resolves.toEqual({
        notice: "SENT",
        email: "buyer@acme.test",
      });
      expect(h.orders.changeStatus).not.toHaveBeenCalled();
      expect(h.messaging.notify).toHaveBeenCalledTimes(1);
      expect(h.notifications.sendToCustomer).not.toHaveBeenCalled();
      expect(h.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "order.ready_for_pickup",
          entityType: "order",
          meta: expect.objectContaining({ notice: "SENT", resend: true }),
        }),
      );
    });

    it("R29: Send again before the order is Ready is refused, nothing sent", async () => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [sentRow]);
      const err = await h.service
        .markReady("ord-1", user, { resend: true })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "ORDER_NOT_READYABLE",
      });
      expect(h.orders.changeStatus).not.toHaveBeenCalled();
      expect(h.messaging.notify).not.toHaveBeenCalled();
    });
  });

  describe("SA-1070 rule 5: GET the record (W-1060)", () => {
    const at = new Date("2026-10-31T14:14:00.000Z");
    const sentRow = { meta: { notice: "SENT", email: "buyer@acme.test" }, createdAt: at };
    const failedRow = {
      meta: { notice: "FAILED", resend: true },
      createdAt: new Date(at.getTime() + 60_000),
    };

    it("answers what a press would do and the last send, with its address and time", async () => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [sentRow]);
      await expect(h.service.getRecord("ord-1", user)).resolves.toEqual({
        preview: { notice: "SENT", email: "buyer@acme.test" },
        last: { notice: "SENT", email: "buyer@acme.test", at: at.toISOString() },
      });
      expect(h.messaging.enabledChannels).toHaveBeenCalledWith("READY_FOR_PICKUP");
    });

    it("no record yet: last is null and the preview says what a press would do", async () => {
      const h = await build();
      await expect(h.service.getRecord("ord-1", user)).resolves.toEqual({
        preview: { notice: "SENT", email: "buyer@acme.test" },
        last: null,
      });
    });

    it("R31: SENT, then a failed resend: last is the SENT row, not the newer FAILED one", async () => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [failedRow, sentRow]);
      const rec = await h.service.getRecord("ord-1", user);
      expect(rec.last).toEqual({
        notice: "SENT",
        email: "buyer@acme.test",
        at: at.toISOString(),
      });
    });

    it("only a failed send on the record: last is that FAILED row", async () => {
      const h = await build(baseOrder, goodCustomer, undefined, undefined, [failedRow]);
      const rec = await h.service.getRecord("ord-1", user);
      expect(rec.last).toMatchObject({ notice: "FAILED" });
    });

    it('reads the row by tenant, the lowercase "order" entity, this order and this action', async () => {
      const h = await build();
      await h.service.getRecord("ord-1", user);
      expect(h.db.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: "t-1",
            entityType: "order",
            entityId: "ord-1",
            action: "order.ready_for_pickup",
          },
        }),
      );
    });

    it("R30: an order that is not this tenant's answers 404 and reads no record", async () => {
      const h = await build();
      h.orders.findOneOrThrow.mockRejectedValue(new NotFoundException("Order not found"));
      await expect(h.service.getRecord("ord-other", user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.db.auditLog.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ["no email on file", { ...goodCustomer, email: null }, "NO_EMAIL"],
      ["opted out", { ...goodCustomer, orderStatusEmails: false }, "OPTED_OUT"],
    ])("preview for a customer with %s reads %s", async (_n, customer, notice) => {
      const h = await build(baseOrder, customer);
      expect((await h.service.getRecord("ord-1", user)).preview.notice).toBe(notice);
    });

    it("preview is OFF when the Ready email is switched off", async () => {
      const h = await build();
      h.messaging.enabledChannels.mockResolvedValue([]);
      expect((await h.service.getRecord("ord-1", user)).preview).toEqual({ notice: "OFF" });
    });
  });

  it("writes the order.ready_for_pickup audit row carrying the notice", async () => {
    const h = await build();
    await h.service.markReady("ord-1", user);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-1",
        userId: "op-1",
        action: "order.ready_for_pickup",
        entityType: "order", // lowercase: the counter-complete claim row beside it says "Order"
        entityId: "ord-1",
        meta: expect.objectContaining({ notice: "SENT" }),
      }),
    );
  });
});
