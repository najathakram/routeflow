import { Test } from "@nestjs/testing";
import { MessageChannel } from "@prisma/client";
import { MessagingService } from "./messaging.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { StubProvider } from "./providers/stub.provider";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * F23 / B145 — transport honesty (cause-ruling.md §2): `outcome === "sent"` must mean a
 * `Message` row was written because a REAL transport (or INTERNAL) accepted the payload, never
 * because the stub happens to return `status:"queued"` unconditionally. This binds the
 * PRODUCTION `StubProvider` (not a mock) at `MESSAGE_PROVIDER`, exactly as the real DI graph
 * does, because the whole point is proving the stub's OWN declared capability — it transports
 * NOTHING today — is what the engine now honestly reports.
 */
describe("MessagingService — transport honesty against the REAL StubProvider (F23 / REG-B145)", () => {
  let service: MessagingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let meter: { increment: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    meter = { increment: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: meter },
        { provide: MESSAGE_PROVIDER, useClass: StubProvider },
      ],
    }).compile();
    service = mod.get(MessagingService);

    // Happy-path defaults: a fully-consented, reachable customer + a thread — the send must get
    // all the way past invoice-policy/consent/opt-out/contact gating so the ONLY reason it can
    // still fail to record is the transport-honesty check itself.
    prisma.customer.findFirst.mockResolvedValue({
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

  const send = (channel: MessageChannel) =>
    service.sendMessage({
      customerId: "cust-1",
      channel,
      body: "Hello",
      senderId: "op-1",
    });

  it("REG-B145 T1: EMAIL is skipped (NO_TRANSPORT) — the real StubProvider transports nothing, so a 'sent' outcome would be fabricated", async () => {
    const res = await send(MessageChannel.EMAIL);
    expect(res).toMatchObject({
      channel: MessageChannel.EMAIL,
      outcome: "skipped",
      reason: "NO_TRANSPORT",
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.messageThread.update).not.toHaveBeenCalled();
  });

  it("REG-B145 T2: PORTAL is skipped the same way (NO_TRANSPORT) — no customer-facing reader exists, so it must not be recorded as sent either", async () => {
    const res = await send(MessageChannel.PORTAL);
    expect(res).toMatchObject({
      channel: MessageChannel.PORTAL,
      outcome: "skipped",
      reason: "NO_TRANSPORT",
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.messageThread.update).not.toHaveBeenCalled();
  });
});
