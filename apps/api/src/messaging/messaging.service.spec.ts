import { Test } from "@nestjs/testing";
import { MessageChannel, MeterKey, NotificationEvent } from "@prisma/client";
import { MessagingService } from "./messaging.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { isQuietHours, renderTemplate } from "./messaging.helpers";

describe("MessagingService (P6-2 engine)", () => {
  let service: MessagingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let provider: { send: jest.Mock };
  let meter: { increment: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    provider = { send: jest.fn().mockResolvedValue({ providerMsgId: "stub-1", status: "queued" }) };
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
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      phone: "+15550001111",
      mobile: null,
      email: "buyer@example.com",
      smsConsent: true,
      waConsent: true,
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
    prisma.customer.findUnique.mockResolvedValue({
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
    prisma.customer.findUnique.mockResolvedValue({
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
