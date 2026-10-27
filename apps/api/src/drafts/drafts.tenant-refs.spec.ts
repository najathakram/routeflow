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
  tenantId: "tenant-a",
  tenantSlug: "acme",
};

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// 681 (R5-5) site 11: SaleDraft.customerId is a bare String? (no FK), so the column is the only guard. It is
// proven at save, create and update. The Json payload is client state and is NOT checked.
describe("DraftsService — tenant refs (681 site 11)", () => {
  let service: DraftsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    prisma.saleDraft.create.mockResolvedValue({ id: "d1" });
    prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
    prisma.saleDraft.findUnique.mockResolvedValue({ id: "d1", userId: "user-1", payload: {} });
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [DraftsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DraftsService);
  });

  describe("create", () => {
    it("another tenant's customer is a 404 and no draft is written", async () => {
      const err = await service
        .create(user, { customerId: "cust-b", payload: {} } as never)
        .catch((e) => e);
      expect(prisma.saleDraft.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Customer not found");
    });

    it("control: this tenant's customer is stored", async () => {
      await service.create(user, { customerId: "cust-a", payload: {} } as never);
      expect(prisma.saleDraft.create).toHaveBeenCalledTimes(1);
    });

    it("a draft with no customer (a walk-in cart) proves nothing", async () => {
      await service.create(user, { payload: {} } as never);
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.saleDraft.create).toHaveBeenCalledTimes(1);
    });

    it("customer ids inside the payload JSON are client state and are not proven", async () => {
      await service.create(user, { payload: { customerId: "cust-b", lines: [] } } as never);
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.saleDraft.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("update", () => {
    it("another tenant's customer is a 404 and the draft is not changed", async () => {
      const err = await service
        .update(user, "d1", { customerId: "cust-b" } as never)
        .catch((e) => e);
      expect(prisma.saleDraft.update).not.toHaveBeenCalled();
      expect(prisma.saleDraft.updateMany).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Customer not found");
    });

    it("also on the compare-and-set path", async () => {
      const err = await service
        .update(user, "d1", {
          customerId: "cust-b",
          expectedUpdatedAt: "2026-10-01T00:00:00Z",
        } as never)
        .catch((e) => e);
      expect(prisma.saleDraft.updateMany).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
    });

    it("control: this tenant's customer is stored", async () => {
      await service.update(user, "d1", { customerId: "cust-a" } as never);
      expect(prisma.saleDraft.update).toHaveBeenCalledTimes(1);
    });

    it("clearing the customer (null) proves nothing and still writes", async () => {
      await service.update(user, "d1", { customerId: null } as never);
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.saleDraft.update).toHaveBeenCalledTimes(1);
    });

    it("a PATCH that does not touch the customer proves nothing", async () => {
      await service.update(user, "d1", { title: "Reorder" } as never);
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.saleDraft.update).toHaveBeenCalledTimes(1);
    });
  });
});
