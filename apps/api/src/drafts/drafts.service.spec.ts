import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DraftsService } from "./drafts.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const user = {
  sub: "user-1",
  username: "maria",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("DraftsService", () => {
  let service: DraftsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [DraftsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DraftsService);
  });

  it("lists only the current user's drafts, newest first", async () => {
    prisma.saleDraft.findMany.mockResolvedValue([]);
    await service.list(user);
    expect(prisma.saleDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        orderBy: { updatedAt: "desc" },
      }),
    );
  });

  it("creates a draft owned by the current user with defaults", async () => {
    prisma.saleDraft.create.mockResolvedValue({ id: "d1" });
    await service.create(user, { payload: { lines: [] } });
    expect(prisma.saleDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1", kind: "ORDER", payload: { lines: [] } }),
      }),
    );
  });

  it("updates only owned drafts", async () => {
    prisma.saleDraft.findUnique.mockResolvedValue({ id: "d1", userId: "user-1" });
    prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
    await service.update(user, "d1", { title: "Sunrise reorder" });
    expect(prisma.saleDraft.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { title: "Sunrise reorder" },
    });
  });

  it("rejects reading/updating another user's draft (ownership)", async () => {
    prisma.saleDraft.findUnique.mockResolvedValue({ id: "d1", userId: "someone-else" });
    await expect(service.get(user, "d1")).rejects.toThrow(NotFoundException);
    await expect(service.update(user, "d1", { title: "x" })).rejects.toThrow(NotFoundException);
    await expect(service.remove(user, "d1")).rejects.toThrow(NotFoundException);
    expect(prisma.saleDraft.update).not.toHaveBeenCalled();
    expect(prisma.saleDraft.delete).not.toHaveBeenCalled();
  });

  it("deletes an owned draft", async () => {
    prisma.saleDraft.findUnique.mockResolvedValue({ id: "d1", userId: "user-1" });
    prisma.saleDraft.delete.mockResolvedValue({ id: "d1" });
    const res = await service.remove(user, "d1");
    expect(prisma.saleDraft.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(res).toEqual({ success: true });
  });
});
