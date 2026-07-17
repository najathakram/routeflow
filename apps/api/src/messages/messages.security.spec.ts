/**
 * Security tests for the run-chat messaging module.
 *
 * F2-006: the run-chat INTERNAL thread is an operator↔driver channel. Before the
 * fix, findByRun had no participant/role check, so any authenticated CUSTOMER
 * could supply a runId and read the internal operator/driver conversation.
 * findByRun now gates reads: OPERATOR/TENANT_ADMIN see everything, a DRIVER may
 * read ONLY a run they are assigned to, and CUSTOMER (or a DRIVER with no runId)
 * is denied.
 */
import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { MessagesService } from "./messages.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("MessagesService — F2-006 run-chat participant gate", () => {
  let service: MessagesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [MessagesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(MessagesService);
  });

  it("CUSTOMER cannot read a run's internal thread (403) and never hits findMany", async () => {
    await expect(
      service.findByRun({ runId: "run-1" }, { sub: "cust-user", role: "CUSTOMER" }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("DRIVER cannot read a run they are NOT assigned to (403)", async () => {
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
    prisma.routeRun.findUnique.mockResolvedValue({ driverId: "drv-2" });

    await expect(
      service.findByRun({ runId: "run-1" }, { sub: "drv-user", role: "DRIVER" }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("DRIVER cannot read the no-runId 'all internal' firehose (403)", async () => {
    await expect(service.findByRun({}, { sub: "drv-user", role: "DRIVER" })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("DRIVER CAN read the internal thread of a run they are assigned to", async () => {
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
    prisma.routeRun.findUnique.mockResolvedValue({ driverId: "drv-1" });

    await service.findByRun({ runId: "run-1" }, { sub: "drv-user", role: "DRIVER" });
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channel: "INTERNAL", runId: "run-1" } }),
    );
  });

  it("OPERATOR reads any run's internal thread without a participant lookup", async () => {
    await service.findByRun({ runId: "run-1" }, { sub: "op-user", role: "OPERATOR" });
    expect(prisma.driver.findFirst).not.toHaveBeenCalled();
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channel: "INTERNAL", runId: "run-1" } }),
    );
  });

  // F2-006 write side: a CUSTOMER must not be able to INJECT into the internal thread.
  it("CUSTOMER cannot CREATE a message in the internal thread (403), never hits create", async () => {
    await expect(
      service.create({ runId: "run-1", text: "hi" }, "cust-user", "CUSTOMER"),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("DRIVER cannot CREATE in a run they are NOT assigned to (403)", async () => {
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
    prisma.routeRun.findUnique.mockResolvedValue({ driverId: "other-drv" });
    await expect(
      service.create({ runId: "run-1", text: "hi" }, "drv-user", "DRIVER"),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("assigned DRIVER and OPERATOR CAN create a run message", async () => {
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
    prisma.routeRun.findUnique.mockResolvedValue({ driverId: "drv-1" });
    await service.create({ runId: "run-1", text: "on my way" }, "drv-user", "DRIVER");
    await service.create({ runId: "run-1", text: "ok" }, "op-user", "OPERATOR");
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });
});
