import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { DraftsService, DRAFT_SUBMIT_KEY_FIELD } from "./drafts.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SaveDraftDto } from "./dto/save-draft.dto";

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

/**
 * SA-817 (A): the draft PATCH is a compare-and-set on `updatedAt` (409 DRAFT_CHANGED), and the order's Idempotency-Key lives in
 * `payload._submitKey`, kept verbatim and never accepted from another draft.
 */
describe("DraftsService - SA-817 A", () => {
  let service: DraftsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const T0 = "2026-10-19T10:00:00.000Z";
  const T1 = "2026-10-19T10:05:00.000Z";
  const owned = (extra: Record<string, unknown> = {}) => ({
    id: "d1",
    userId: "user-1",
    updatedAt: new Date(T1),
    payload: { _submitKey: "key-d1", lineItems: [] },
    ...extra,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [DraftsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DraftsService);
    prisma.saleDraft.findFirst.mockResolvedValue(null);
  });

  describe("A4 - expectedUpdatedAt compare-and-set", () => {
    it("A4: a stale expectedUpdatedAt is a 409 DRAFT_CHANGED carrying the current row, and nothing is written", async () => {
      const current = owned();
      prisma.saleDraft.findUnique.mockResolvedValue(current);
      prisma.saleDraft.updateMany.mockResolvedValue({ count: 0 });

      const err = await service
        .update(user, "d1", { payload: { lineItems: [1] }, expectedUpdatedAt: T0 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.DRAFT_CHANGED, current });
      expect(prisma.saleDraft.update).not.toHaveBeenCalled();
    });

    it("A4: the compare is part of the write (updateMany where id + userId + updatedAt), not a read-then-write", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned());
      prisma.saleDraft.updateMany.mockResolvedValue({ count: 1 });

      const row = await service.update(user, "d1", { title: "x", expectedUpdatedAt: T1 });

      expect(prisma.saleDraft.updateMany).toHaveBeenCalledWith({
        where: { id: "d1", userId: "user-1", updatedAt: new Date(T1) },
        data: { title: "x" },
      });
      expect(prisma.saleDraft.update).not.toHaveBeenCalled();
      expect(row).toMatchObject({ id: "d1" });
    });

    it("without expectedUpdatedAt the write is last-write-wins exactly as before (older clients)", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned());
      prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
      await service.update(user, "d1", { title: "x" });
      expect(prisma.saleDraft.update).toHaveBeenCalledWith({
        where: { id: "d1" },
        data: { title: "x" },
      });
      expect(prisma.saleDraft.updateMany).not.toHaveBeenCalled();
    });

    it("a draft deleted between the checks is a 404, not a conflict", async () => {
      prisma.saleDraft.findUnique.mockResolvedValueOnce(owned()).mockResolvedValueOnce(null);
      prisma.saleDraft.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.update(user, "d1", { title: "x", expectedUpdatedAt: T0 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("another user's draft is still a 404 with expectedUpdatedAt (ownership first)", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned({ userId: "someone-else" }));
      await expect(
        service.update(user, "d1", { title: "x", expectedUpdatedAt: T1 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.saleDraft.updateMany).not.toHaveBeenCalled();
    });

    it("DRAFT_CHANGED is a registered shared error code", () => {
      expect(API_ERROR_CODES.DRAFT_CHANGED).toBe("DRAFT_CHANGED");
    });

    it("SaveDraftDto accepts an ISO expectedUpdatedAt and rejects junk", async () => {
      const ok = plainToInstance(SaveDraftDto, { expectedUpdatedAt: T1 });
      const bad = plainToInstance(SaveDraftDto, { expectedUpdatedAt: "yesterday" });
      expect(await validate(ok)).toHaveLength(0);
      expect(await validate(bad)).not.toHaveLength(0);
    });
  });

  describe("A6 - the submit key persisted in payload._submitKey", () => {
    it("the field name is the shared one", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const shared = require("@routeflow/types/draft-submit-key") as {
        DRAFT_SUBMIT_KEY_FIELD: string;
      };
      expect(DRAFT_SUBMIT_KEY_FIELD).toBe(shared.DRAFT_SUBMIT_KEY_FIELD);
    });

    it("A6: create keeps the key verbatim", async () => {
      prisma.saleDraft.create.mockResolvedValue({ id: "d1" });
      await service.create(user, { payload: { _submitKey: "K-1-ok?" } });
      expect(prisma.saleDraft.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payload: { _submitKey: "K-1-ok?" } }),
        }),
      );
    });

    it("A6: an update that carries a different key stores it verbatim (the client re-minted after a refusal)", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned());
      prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
      await service.update(user, "d1", { payload: { _submitKey: "key-new", lineItems: [1] } });
      expect(prisma.saleDraft.update).toHaveBeenCalledWith({
        where: { id: "d1" },
        data: { payload: { _submitKey: "key-new", lineItems: [1] } },
      });
    });

    it("A6: an update whose payload omits the key keeps the stored one (an old client or a poison-pill write cannot erase it)", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned());
      prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
      await service.update(user, "d1", { payload: { lineItems: [1], submittedAt: "t" } });
      expect(prisma.saleDraft.update).toHaveBeenCalledWith({
        where: { id: "d1" },
        data: { payload: { lineItems: [1], submittedAt: "t", _submitKey: "key-d1" } },
      });
    });

    it("A6: a payload that never had a key is stored as sent (the server never mints one)", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned({ payload: { lineItems: [] } }));
      prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
      await service.update(user, "d1", { payload: { lineItems: [1] } });
      expect(prisma.saleDraft.update).toHaveBeenCalledWith({
        where: { id: "d1" },
        data: { payload: { lineItems: [1] } },
      });
    });

    it("A6: a key that is on ANOTHER draft of this user is refused on create and on update, and nothing is written", async () => {
      prisma.saleDraft.findFirst.mockResolvedValue({ id: "d-other" });
      prisma.saleDraft.findUnique.mockResolvedValue(owned());

      await expect(service.create(user, { payload: { _submitKey: "key-d1" } })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.update(user, "d1", { payload: { _submitKey: "key-of-d-other" } }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.saleDraft.create).not.toHaveBeenCalled();
      expect(prisma.saleDraft.update).not.toHaveBeenCalled();
    });

    it("A6: the other-draft lookup is scoped to this user and excludes the draft being written", async () => {
      prisma.saleDraft.findUnique.mockResolvedValue(owned());
      prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
      await service.update(user, "d1", { payload: { _submitKey: "key-d1" } });
      expect(prisma.saleDraft.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            id: { not: "d1" },
            payload: { path: ["_submitKey"], equals: "key-d1" },
          },
        }),
      );
      // its own key is fine
      expect(prisma.saleDraft.update).toHaveBeenCalled();
    });

    it("A6: a key that is not a legal Idempotency-Key header value is refused", async () => {
      for (const bad of ["", "has space", "x".repeat(129), 42, null]) {
        await expect(service.create(user, { payload: { _submitKey: bad } })).rejects.toThrow(
          BadRequestException,
        );
      }
      expect(prisma.saleDraft.create).not.toHaveBeenCalled();
    });

    it("a payload with no _submitKey field never looks anything up", async () => {
      prisma.saleDraft.create.mockResolvedValue({ id: "d1" });
      await service.create(user, { payload: { lineItems: [] } });
      expect(prisma.saleDraft.findFirst).not.toHaveBeenCalled();
    });
  });
});
