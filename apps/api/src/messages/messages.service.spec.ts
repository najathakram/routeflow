import { Test } from "@nestjs/testing";
import { MessagesService } from "./messages.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * P6-1 (F0) run-chat regression lock. The messaging thread schema additively
 * generalized the Message model (new nullable `threadId` + `channel` defaulting
 * to INTERNAL). This spec pins the driver ↔ operator run-chat create/read paths
 * so the additive columns can never silently change how run-chat writes/reads:
 * `create` must NOT set channel/threadId (they default), and `findByRun` must
 * keep its exact where/orderBy/include shape.
 */
describe("MessagesService (run-chat)", () => {
  let service: MessagesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [MessagesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(MessagesService);
  });

  it("creates a run-chat message WITHOUT setting channel/threadId (both default)", async () => {
    await service.create({ runId: "run-1", text: "on my way" }, "user-9", "DRIVER");

    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    const arg = prisma.message.create.mock.calls[0][0];
    // Exact create shape — the four run-chat fields only.
    expect(arg.data).toEqual({
      runId: "run-1",
      text: "on my way",
      senderId: "user-9",
      senderRole: "DRIVER",
    });
    // The additive columns must be left to their DB/Prisma defaults, never written here.
    expect(arg.data).not.toHaveProperty("channel");
    expect(arg.data).not.toHaveProperty("threadId");
    // Sender is still hydrated for the client.
    expect(arg.include).toEqual({ sender: { select: { id: true, username: true, role: true } } });
  });

  it("coerces a missing runId to null on create (unchanged behavior)", async () => {
    await service.create({ text: "hi" } as { text: string; runId?: string }, "u1", "OPERATOR");
    expect(prisma.message.create.mock.calls[0][0].data.runId).toBeNull();
  });

  it("reads a run's messages scoped to the INTERNAL channel", async () => {
    await service.findByRun({ runId: "run-1" });
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { channel: "INTERNAL", runId: "run-1" },
      orderBy: { createdAt: "asc" },
      include: { sender: { select: { id: true, username: true, role: true } } },
    });
  });

  it("scopes the no-runId list to INTERNAL so engine messages never leak in", async () => {
    await service.findByRun({});
    expect(prisma.message.findMany.mock.calls[0][0].where).toEqual({ channel: "INTERNAL" });
  });
});
