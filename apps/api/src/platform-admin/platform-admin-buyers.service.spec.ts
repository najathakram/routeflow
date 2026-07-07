import { Test, TestingModule } from "@nestjs/testing";
import { PlatformAdminBuyersService } from "./platform-admin-buyers.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The buyer/merge models aren't in the shared prisma-mock (they belong to the
 * buyer module), so this hand-rolls just the surface this read-only service
 * touches.
 */
function makePrisma() {
  return {
    buyerAccount: { findMany: jest.fn(), count: jest.fn() },
    customerLink: { groupBy: jest.fn() },
    buyerMergeRequest: { findMany: jest.fn(), count: jest.fn() },
  };
}

describe("PlatformAdminBuyersService", () => {
  let service: PlatformAdminBuyersService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlatformAdminBuyersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PlatformAdminBuyersService);
  });

  describe("getBuyerDirectory", () => {
    it("computes distinct sellers, orders-90d, business name, and global segment counts", async () => {
      prisma.customerLink.groupBy.mockResolvedValue([{ buyerAccountId: "b1" }]);
      prisma.buyerAccount.findMany.mockResolvedValue([
        {
          id: "b1",
          email: "a@x.com",
          name: "Alice",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: new Date(),
          customerLinks: [
            { tenantId: "t1", customer: { businessName: "Acme", _count: { orders: 3 } } },
            { tenantId: "t2", customer: { businessName: "Acme West", _count: { orders: 2 } } },
          ],
        },
      ]);
      prisma.buyerAccount.count
        .mockResolvedValueOnce(10) // total (filtered where)
        .mockResolvedValueOnce(10) // all (base)
        .mockResolvedValueOnce(2); // unverified

      const res = await service.getBuyerDirectory({ page: 1, limit: 25 });

      expect(res.data[0]).toMatchObject({ sellers: 2, orders90d: 5, businessName: "Acme" });
      expect(res.segments).toEqual({ all: 10, multiSeller: 1, unverified: 2 });
      expect(res.meta.total).toBe(10);
    });

    it("applies the multi-seller and unverified segment filters", async () => {
      prisma.customerLink.groupBy.mockResolvedValue([
        { buyerAccountId: "b1" },
        { buyerAccountId: "b2" },
      ]);
      prisma.buyerAccount.findMany.mockResolvedValue([]);
      prisma.buyerAccount.count.mockResolvedValue(0);

      await service.getBuyerDirectory({ segment: "multi-seller" });
      expect(prisma.buyerAccount.findMany.mock.calls.at(-1)![0].where.id).toEqual({
        in: ["b1", "b2"],
      });

      await service.getBuyerDirectory({ segment: "unverified" });
      expect(prisma.buyerAccount.findMany.mock.calls.at(-1)![0].where.emailVerified).toBe(false);
    });
  });

  describe("getPendingMergeSummary", () => {
    it("enriches both accounts with sellers + orders-90d and returns pendingCount + notes", async () => {
      prisma.buyerMergeRequest.findMany.mockResolvedValue([
        {
          id: "m1",
          status: "PENDING_REVIEW",
          initiatedBy: "BUYER",
          initiatorNotes: "Old personal account, same store.",
          createdAt: new Date(),
          primaryAccount: {
            id: "p",
            email: "p@x.com",
            name: "P",
            customerLinks: [
              { tenantId: "t1", customer: { businessName: "B", _count: { orders: 80 } } },
              { tenantId: "t2", customer: { businessName: "B2", _count: { orders: 6 } } },
            ],
          },
          secondaryAccount: {
            id: "s",
            email: "s@x.com",
            name: "S",
            customerLinks: [
              { tenantId: "t1", customer: { businessName: "B", _count: { orders: 12 } } },
            ],
          },
        },
      ]);
      prisma.buyerMergeRequest.count.mockResolvedValue(1);

      const res = await service.getPendingMergeSummary({ limit: 10 });

      expect(res.pendingCount).toBe(1);
      expect(res.data[0].primary).toMatchObject({ sellers: 2, orders90d: 86 });
      expect(res.data[0].secondary).toMatchObject({ sellers: 1, orders90d: 12 });
      expect(res.data[0].initiatorNotes).toBe("Old personal account, same store.");
      // Only PENDING_REVIEW requests are summarised.
      expect(prisma.buyerMergeRequest.findMany.mock.calls[0][0].where.status).toBe(
        "PENDING_REVIEW",
      );
    });
  });
});
