import { Test } from "@nestjs/testing";
import { MessageChannel, MeterKey, NotificationEvent } from "@prisma/client";
import { MessagingService } from "./messaging.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { DEFAULT_TEMPLATES } from "./messaging-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { isQuietHours, renderTemplate } from "./messaging.helpers";

describe("MessagingService (P6-2 engine)", () => {
  let service: MessagingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let provider: { send: jest.Mock; transports: jest.Mock };
  let meter: { increment: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    provider = {
      send: jest.fn().mockResolvedValue({ providerMsgId: "stub-1", status: "queued" }),
      // F23/B145 (cause-ruling.md §2): sendMessage() now asks the provider whether it actually
      // transports a channel before recording a "sent" outcome. These tests are about the
      // record/meter/notify contract GIVEN a transport exists, not about transport honesty
      // itself (that's messaging.transport-honesty.spec.ts against the REAL StubProvider, which
      // declares none) — so this mock declares every channel it uses transportable.
      transports: jest.fn().mockReturnValue(true),
    };
    meter = { increment: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: meter },
        { provide: MESSAGE_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = mod.get(MessagingService);

    // Happy-path defaults: a fully-consented, reachable customer + a thread.
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      phone: "+15550001111",
      mobile: null,
      email: "buyer@example.com",
      smsConsent: true,
      waConsent: true,
      // N1: matches the schema default (Customer.orderStatusEmails @default(true)).
      orderStatusEmails: true,
    });
    prisma.messageThread.findFirst.mockResolvedValue({ id: "thread-1" });
    prisma.messageThread.create.mockResolvedValue({ id: "thread-1" });
    prisma.message.create.mockResolvedValue({ id: "msg-1" });
    prisma.messageThread.update.mockResolvedValue({ id: "thread-1" });
    prisma.messageOptOut.findFirst.mockResolvedValue(null);
    prisma.messagingSettings.findUnique.mockResolvedValue(null);
  });

  const send = (over: Partial<Parameters<MessagingService["sendMessage"]>[0]> = {}) =>
    service.sendMessage({
      customerId: "cust-1",
      channel: MessageChannel.WHATSAPP,
      body: "Hello",
      senderId: "op-1",
      ...over,
    });

  it("sends WhatsApp: dispatches, records a Message on the thread, bumps it, meters MSGS", async () => {
    const res = await send({ channel: MessageChannel.WHATSAPP });
    expect(res.outcome).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
    const msg = prisma.message.create.mock.calls[0][0].data;
    expect(msg).toMatchObject({
      threadId: "thread-1",
      channel: "WHATSAPP",
      senderRole: "OPERATOR",
    });
    const bump = prisma.messageThread.update.mock.calls[0][0].data;
    expect(bump.lastChannel).toBe("WHATSAPP");
    expect(bump.unreadCount).toEqual({ increment: 1 });
    expect(meter.increment).toHaveBeenCalledWith("test-tenant", MeterKey.MSGS, 1);
  });

  it("SMS is metered", async () => {
    await send({ channel: MessageChannel.SMS });
    expect(meter.increment).toHaveBeenCalledWith("test-tenant", MeterKey.MSGS, 1);
  });

  it("INTERNAL: records but does NOT use the provider and does NOT meter", async () => {
    const res = await send({ channel: MessageChannel.INTERNAL });
    expect(res.outcome).toBe("sent");
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(meter.increment).not.toHaveBeenCalled();
  });

  it("EMAIL: dispatches via provider but is NOT metered", async () => {
    await send({ channel: MessageChannel.EMAIL });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(meter.increment).not.toHaveBeenCalled();
  });

  it("does NOT record or meter when the provider reports a failed send", async () => {
    provider.send.mockResolvedValueOnce({ providerMsgId: "x", status: "failed" });
    const res = await send({ channel: MessageChannel.SMS });
    expect(res).toMatchObject({ outcome: "failed", reason: "SEND_FAILED" });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(meter.increment).not.toHaveBeenCalled();
  });

  it("G12: refuses INVOICE_SENT over WhatsApp/SMS (no dispatch, no meter)", async () => {
    const res = await send({
      channel: MessageChannel.WHATSAPP,
      eventKey: NotificationEvent.INVOICE_SENT,
    });
    expect(res).toMatchObject({ outcome: "skipped", reason: "INVOICE_POLICY" });
    expect(provider.send).not.toHaveBeenCalled();
    expect(meter.increment).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("G12: allows INVOICE_SENT over EMAIL", async () => {
    const res = await send({
      channel: MessageChannel.EMAIL,
      eventKey: NotificationEvent.INVOICE_SENT,
    });
    expect(res.outcome).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("blocks WhatsApp/SMS when consent is missing", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      phone: "+15550001111",
      mobile: null,
      email: "buyer@example.com",
      smsConsent: false,
      waConsent: false,
    });
    const res = await send({ channel: MessageChannel.SMS });
    expect(res).toMatchObject({ outcome: "skipped", reason: "NO_CONSENT" });
    expect(provider.send).not.toHaveBeenCalled();
    expect(meter.increment).not.toHaveBeenCalled();
  });

  it("blocks WhatsApp/SMS when opted out", async () => {
    prisma.messageOptOut.findFirst.mockResolvedValue({ id: "oo-1" });
    const res = await send({ channel: MessageChannel.SMS });
    expect(res).toMatchObject({ outcome: "skipped", reason: "OPTED_OUT" });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("skips a provider channel with no contact on file", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      phone: null,
      mobile: null,
      email: "buyer@example.com",
      smsConsent: true,
      waConsent: true,
    });
    const res = await send({ channel: MessageChannel.SMS });
    expect(res).toMatchObject({ outcome: "skipped", reason: "NO_CONTACT" });
  });

  it.each(["acme_store@imported.local", "no-email+abc123@placeholder.local"])(
    "EMAIL to the import sentinel %s is NO_CONTACT, not a doomed send",
    async (sentinel) => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        phone: "+15550001111",
        mobile: null,
        email: sentinel,
        smsConsent: true,
        waConsent: true,
        orderStatusEmails: true,
      });
      const res = await send({ channel: MessageChannel.EMAIL });
      expect(res).toMatchObject({ outcome: "skipped", reason: "NO_CONTACT" });
      expect(provider.send).not.toHaveBeenCalled();
    },
  );

  describe("N1 — Customer.orderStatusEmails gates order-status EMAIL only (opt-out, default true)", () => {
    const optedOutCustomer = {
      id: "cust-1",
      phone: "+15550001111",
      mobile: null,
      email: "buyer@example.com",
      smsConsent: true,
      waConsent: true,
      orderStatusEmails: false,
    };

    it("skips ORDER_CONFIRMED over EMAIL when the buyer opted out", async () => {
      prisma.customer.findFirst.mockResolvedValue(optedOutCustomer);
      const res = await send({
        channel: MessageChannel.EMAIL,
        eventKey: NotificationEvent.ORDER_CONFIRMED,
      });
      expect(res).toMatchObject({ outcome: "skipped", reason: "OPTED_OUT" });
      expect(provider.send).not.toHaveBeenCalled();
    });

    it.each([
      NotificationEvent.OUT_FOR_DELIVERY,
      NotificationEvent.ORDER_SHIPPED,
      NotificationEvent.SHIPMENT_TRACKING_ADDED,
      NotificationEvent.READY_FOR_PICKUP,
      NotificationEvent.DELIVERED,
      NotificationEvent.CANCELLED,
      NotificationEvent.ORDER_CHANGED_AT_DOOR,
    ])("skips %s over EMAIL when the buyer opted out", async (eventKey) => {
      prisma.customer.findFirst.mockResolvedValue(optedOutCustomer);
      const res = await send({ channel: MessageChannel.EMAIL, eventKey });
      expect(res).toMatchObject({ outcome: "skipped", reason: "OPTED_OUT" });
    });

    it("does NOT gate INVOICE_SENT over EMAIL — only the five order-status events are opt-out", async () => {
      prisma.customer.findFirst.mockResolvedValue(optedOutCustomer);
      const res = await send({
        channel: MessageChannel.EMAIL,
        eventKey: NotificationEvent.INVOICE_SENT,
      });
      expect(res.outcome).toBe("sent");
      expect(provider.send).toHaveBeenCalledTimes(1);
    });

    it("does NOT gate a non-EMAIL channel for an order-status event — opt-out is EMAIL-only", async () => {
      prisma.customer.findFirst.mockResolvedValue(optedOutCustomer);
      const res = await send({
        channel: MessageChannel.WHATSAPP,
        eventKey: NotificationEvent.ORDER_CONFIRMED,
      });
      expect(res.outcome).toBe("sent");
    });

    it("sends normally when orderStatusEmails is true (default)", async () => {
      const res = await send({
        channel: MessageChannel.EMAIL,
        eventKey: NotificationEvent.ORDER_CONFIRMED,
      });
      expect(res.outcome).toBe("sent");
      expect(provider.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("notify() channels / exceptChannels (carrier-shipped per-channel split)", () => {
    const tpl = { body: "Hi {{customerName}}", isActive: true, waTemplateName: null };
    const rulesOn = (...channels: MessageChannel[]) =>
      prisma.notificationRule.findMany.mockResolvedValue(channels.map((channel) => ({ channel })));

    it("channels: dispatches ONLY on the listed channels", async () => {
      rulesOn(MessageChannel.EMAIL, MessageChannel.PORTAL);
      prisma.messageTemplate.findFirst.mockResolvedValue(tpl);
      const out = await service.notify(NotificationEvent.ORDER_SHIPPED, {
        customerId: "cust-1",
        senderId: "op-1",
        channels: [MessageChannel.PORTAL],
      });
      expect(out.map((o) => o.channel)).toEqual([MessageChannel.PORTAL]);
    });

    it("exceptChannels: skips the listed channels, the rest still send", async () => {
      rulesOn(MessageChannel.EMAIL, MessageChannel.PORTAL);
      prisma.messageTemplate.findFirst.mockResolvedValue(tpl);
      const out = await service.notify(NotificationEvent.ORDER_SHIPPED, {
        customerId: "cust-1",
        senderId: "op-1",
        exceptChannels: [MessageChannel.EMAIL],
      });
      expect(out.map((o) => o.channel)).toEqual([MessageChannel.PORTAL]);
    });

    it("omitted: every enabled channel sends (existing callers unchanged)", async () => {
      rulesOn(MessageChannel.EMAIL, MessageChannel.PORTAL);
      prisma.messageTemplate.findFirst.mockResolvedValue(tpl);
      const out = await service.notify(NotificationEvent.ORDER_SHIPPED, {
        customerId: "cust-1",
        senderId: "op-1",
      });
      expect(out.map((o) => o.channel)).toEqual([MessageChannel.EMAIL, MessageChannel.PORTAL]);
    });

    it("a disabled rule (not returned by the enabled query) never sends, even when listed in channels", async () => {
      rulesOn(MessageChannel.PORTAL);
      prisma.messageTemplate.findFirst.mockResolvedValue(tpl);
      const out = await service.notify(NotificationEvent.ORDER_SHIPPED, {
        customerId: "cust-1",
        senderId: "op-1",
        channels: [MessageChannel.EMAIL],
      });
      expect(out).toHaveLength(0);
    });

    it("ORDER_SHIPPED over EMAIL is suppressed by Customer.orderStatusEmails=false but PORTAL still sends", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        phone: null,
        mobile: null,
        email: "buyer@example.com",
        smsConsent: false,
        waConsent: false,
        orderStatusEmails: false,
      });
      rulesOn(MessageChannel.EMAIL, MessageChannel.PORTAL);
      prisma.messageTemplate.findFirst.mockResolvedValue(tpl);
      const out = await service.notify(NotificationEvent.SHIPMENT_TRACKING_ADDED, {
        customerId: "cust-1",
        senderId: "op-1",
      });
      expect(out.find((o) => o.channel === MessageChannel.EMAIL)).toMatchObject({
        outcome: "skipped",
        reason: "OPTED_OUT",
      });
      expect(out.find((o) => o.channel === MessageChannel.PORTAL)?.outcome).toBe("sent");
    });
  });

  describe("customisedChannels()", () => {
    const orig = DEFAULT_TEMPLATES[NotificationEvent.OUT_FOR_DELIVERY].body;

    it("reports only ENABLED, ACTIVE channels whose body differs from the shipped default", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([
        { channel: MessageChannel.EMAIL },
        { channel: MessageChannel.PORTAL },
        { channel: MessageChannel.WHATSAPP },
      ]);
      prisma.messageTemplate.findMany.mockResolvedValue([
        { channel: MessageChannel.EMAIL, body: "Our own words for {{orderNumber}}" },
        { channel: MessageChannel.PORTAL, body: orig },
        {
          channel: MessageChannel.WHATSAPP,
          body: `  ${orig}
`,
        }, // whitespace-only drift is NOT a customisation
        { channel: MessageChannel.SMS, body: "customised but its rule is off" },
      ]);
      expect(await service.customisedChannels(NotificationEvent.OUT_FOR_DELIVERY)).toEqual([
        MessageChannel.EMAIL,
      ]);
    });

    it("reports none when nothing was ever seeded", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([]);
      prisma.messageTemplate.findMany.mockResolvedValue([]);
      expect(await service.customisedChannels(NotificationEvent.OUT_FOR_DELIVERY)).toEqual([]);
    });

    it("never throws: a read failure reports none customised", async () => {
      prisma.notificationRule.findMany.mockRejectedValue(new Error("db down"));
      await expect(service.customisedChannels(NotificationEvent.OUT_FOR_DELIVERY)).resolves.toEqual(
        [],
      );
    });
  });

  describe("notify()", () => {
    it("dispatches only ENABLED rules and renders their template", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([{ channel: MessageChannel.WHATSAPP }]);
      prisma.messageTemplate.findFirst.mockResolvedValue({
        body: "Hi {{name}}, order {{id}} is out.",
        isActive: true,
        waTemplateName: "order_out",
      });
      const outcomes = await service.notify(NotificationEvent.OUT_FOR_DELIVERY, {
        customerId: "cust-1",
        senderId: "op-1",
        vars: { name: "Acme", id: 42 },
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ channel: "WHATSAPP", outcome: "sent" });
      expect(provider.send.mock.calls[0][0].body).toBe("Hi Acme, order 42 is out.");
    });

    it("skips a channel with no active template", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([{ channel: MessageChannel.SMS }]);
      prisma.messageTemplate.findFirst.mockResolvedValue(null);
      const outcomes = await service.notify(NotificationEvent.DELIVERED, {
        customerId: "cust-1",
        senderId: "op-1",
      });
      expect(outcomes).toHaveLength(0);
      expect(provider.send).not.toHaveBeenCalled();
    });

    it("N1 (Opus review): ignores a stale persisted rule for a channel EVENT_CHANNELS no longer allows for this event", async () => {
      // INVOICE_SENT:EMAIL was seeded ON for existing tenants before N1 removed EMAIL
      // from INVOICE_SENT's channels — a persisted, still-enabled row for it must
      // never fire again, or (now that EmailChannelProvider makes EMAIL real) it
      // would duplicate the real PDF invoice email invoices.service.ts already sends.
      prisma.notificationRule.findMany.mockResolvedValue([
        { channel: MessageChannel.EMAIL },
        { channel: MessageChannel.PORTAL },
      ]);
      prisma.messageTemplate.findFirst.mockResolvedValue({
        body: "Hi {{customerName}}, invoice {{invoiceNumber}} is ready.",
        isActive: true,
        waTemplateName: null,
      });

      const outcomes = await service.notify(NotificationEvent.INVOICE_SENT, {
        customerId: "cust-1",
        senderId: "op-1",
        vars: { customerName: "Acme", invoiceNumber: "INV-1" },
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].channel).toBe(MessageChannel.PORTAL);
      expect(provider.send).not.toHaveBeenCalled();
    });

    it("passes DEFAULT_TEMPLATES[eventKey].label as the subject to the provider", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([{ channel: MessageChannel.EMAIL }]);
      prisma.messageTemplate.findFirst.mockResolvedValue({
        body: "Hi {{customerName}}, your order {{orderNumber}} is confirmed.",
        isActive: true,
        waTemplateName: null,
      });

      await service.notify(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "op-1",
        vars: { customerName: "Acme", orderNumber: "ORD-1" },
      });

      expect(provider.send.mock.calls[0][0].subject).toBe(
        DEFAULT_TEMPLATES[NotificationEvent.ORDER_CONFIRMED].label,
      );
    });

    it("REG-B182 T7: seeds the default matrix for a never-visited tenant (empty rule table), then dispatches from it", async () => {
      // Today notificationRule.findMany([]) → notify() just sees zero enabled rules and gives up;
      // there is no seed call and no outcome, even though ORDER_CONFIRMED:EMAIL is documented as
      // enabled by default (N1). Once notify() seeds an empty tenant before reading rules, the
      // SAME call sequence must both seed once and go on to dispatch.
      prisma.notificationRule.findMany
        .mockResolvedValueOnce([]) // never-visited tenant: nothing seeded yet
        .mockResolvedValue([{ channel: MessageChannel.EMAIL }]); // re-read after the seed
      prisma.notificationRule.createMany.mockResolvedValue({ count: 1 });
      prisma.messageTemplate.createMany.mockResolvedValue({ count: 1 });
      prisma.messageTemplate.findFirst.mockResolvedValue({
        body: "Hi {{customerName}}, your order {{orderNumber}} is confirmed for delivery on {{deliveryDate}}. Total: {{orderTotal}}.",
        isActive: true,
        waTemplateName: null,
      });

      const outcomes = await service.notify(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "op-1",
        vars: {
          customerName: "Acme",
          orderNumber: "ORD-1",
          deliveryDate: "2026-10-01",
          orderTotal: "$10.00",
        },
      });

      expect(prisma.notificationRule.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.notificationRule.createMany.mock.calls[0][0]).toMatchObject({
        skipDuplicates: true,
      });
      const seeded = prisma.notificationRule.createMany.mock.calls[0][0].data;
      expect(seeded).toContainEqual(
        expect.objectContaining({
          eventKey: NotificationEvent.ORDER_CONFIRMED,
          channel: MessageChannel.EMAIL,
          enabled: true,
        }),
      );
      expect(seeded).toContainEqual(
        expect.objectContaining({
          eventKey: NotificationEvent.ORDER_CONFIRMED,
          channel: MessageChannel.WHATSAPP,
          enabled: false,
        }),
      );
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      expect(outcomes[0]).toMatchObject({ channel: "EMAIL", outcome: "sent" });
    });
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  it("substitutes {{vars}} (whitespace tolerant) and empties missing ones", () => {
    expect(renderTemplate("Hi {{name}}, #{{ id }}", { name: "A", id: 7 })).toBe("Hi A, #7");
    expect(renderTemplate("Hi {{missing}}!", {})).toBe("Hi !");
  });
});

describe("isQuietHours (wrap-around 21:00→07:00)", () => {
  const s = { quietHoursEnabled: true, quietHoursStart: "21:00", quietHoursEnd: "07:00" };
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  it.each([
    [22, true],
    [6, true],
    [0, true],
    [7, false],
    [8, false],
    [20, false],
  ])("%i:00 → %s", (h, expected) => {
    expect(isQuietHours(at(h as number), s)).toBe(expected);
  });
  it("returns false when quiet hours are disabled", () => {
    expect(isQuietHours(at(23), { ...s, quietHoursEnabled: false })).toBe(false);
  });
});
