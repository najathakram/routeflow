import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MessageChannel, NotificationEvent } from "@prisma/client";
import { MessagingService } from "./messaging.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { EmailChannelProvider } from "./providers/email-channel.provider";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * W-1286 PR-1 (SA-1202 C7): an order-status email writes a delivery row. The order the email is about is threaded
 * from the notifier through the messaging engine to the EMAIL provider, which passes a delivery context
 * (kind ORDER_STATUS, entity Order). Without that thread there is no row, and a bounce could not be matched.
 * Bundled (decision.md): the provider's not-delivered log never prints the full address.
 */
describe("order-status emails carry the order to the provider (C7)", () => {
  let service: MessagingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let provider: { send: jest.Mock; transports: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    provider = {
      send: jest.fn().mockResolvedValue({ providerMsgId: "m-1", status: "sent" }),
      transports: jest.fn().mockReturnValue(true),
    };
    const mod = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: { increment: jest.fn() } },
        { provide: MESSAGE_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = mod.get(MessagingService);
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      phone: null,
      mobile: null,
      email: "buyer@example.com",
      smsConsent: true,
      waConsent: true,
      orderStatusEmails: true,
    });
    prisma.messageThread.findFirst.mockResolvedValue({ id: "thread-1" });
    prisma.message.create.mockResolvedValue({ id: "msg-1" });
    prisma.messageThread.update.mockResolvedValue({ id: "thread-1" });
    prisma.messagingSettings.findUnique.mockResolvedValue(null);
  });

  it("sendMessage hands the entity to provider.send", async () => {
    await service.sendMessage({
      customerId: "cust-1",
      channel: MessageChannel.EMAIL,
      body: "Hello",
      senderId: "op-1",
      eventKey: NotificationEvent.ORDER_CONFIRMED,
      entity: { type: "Order", id: "ord-1" },
    });
    expect(provider.send.mock.calls[0][0].entity).toEqual({ type: "Order", id: "ord-1" });
  });

  it("a send with no entity hands none (every other caller is unchanged)", async () => {
    await service.sendMessage({
      customerId: "cust-1",
      channel: MessageChannel.EMAIL,
      body: "Hello",
      senderId: "op-1",
    });
    expect(provider.send.mock.calls[0][0].entity).toBeUndefined();
  });
});

describe("EmailChannelProvider: the delivery context (C7) and the log (bundled fix)", () => {
  function make(result: object = { delivered: true, transport: "smtp", id: "e1" }) {
    const send = jest.fn().mockResolvedValue(result);
    const emailService = {
      send,
      tenantLook: jest.fn().mockResolvedValue({ kind: "neutral" }),
    } as any;
    return { provider: new EmailChannelProvider(emailService), send };
  }
  const input = {
    tenantId: "t1",
    channel: MessageChannel.EMAIL,
    to: "buyer@example.com",
    body: "Hello",
    subject: "Order confirmed",
  };

  it("an order entity becomes kind ORDER_STATUS on entity Order/ord-1", async () => {
    const { provider, send } = make();
    await provider.send({ ...input, entity: { type: "Order", id: "ord-1" } });
    expect(send.mock.calls[0][0].delivery).toEqual({
      tenantId: "t1",
      kind: "ORDER_STATUS",
      entityType: "Order",
      entityId: "ord-1",
    });
  });

  it("no entity, or no tenant: no delivery context (nothing recorded, as before)", async () => {
    const a = make();
    await a.provider.send(input);
    expect(a.send.mock.calls[0][0]).not.toHaveProperty("delivery");
    const b = make();
    await b.provider.send({ ...input, tenantId: null, entity: { type: "Order", id: "ord-1" } });
    expect(b.send.mock.calls[0][0]).not.toHaveProperty("delivery");
  });

  it("a not-delivered send logs the domain only, never the full address", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { provider } = make({ delivered: false, transport: "smtp", error: "refused" });
    await provider.send(input);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("@example.com");
    expect(logged).not.toContain("buyer@example.com");
    warn.mockRestore();
  });
});
