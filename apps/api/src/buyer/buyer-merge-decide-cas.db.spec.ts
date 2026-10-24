/**
 * Row 424: an admin's executeMerge / rejectMerge DECIDE a buyer merge request with a compare-and-set on its status,
 * inside the transaction. Against a REAL Postgres: two concurrent executes of one request, and an execute racing a
 * reject, have exactly ONE winner; the loser is a 409 MERGE_ALREADY_DECIDED and nothing is applied twice or
 * contradicted (a rejected request never ends up with a merged secondary, a completed one is never rejected).
 *
 * BuyerAccount / BuyerMergeRequest are global (not tenant-scoped); every row is created with a per-run marker and
 * deleted in afterAll. Collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { BuyerMergeRequestStatus } from "@prisma/client";
import { describeDb } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { BuyerMergeService } from "./buyer-merge.service";

describeDb(
  "buyer merge decide — compare-and-set on the request status (row 424, real Postgres)",
  () => {
    const run = randomUUID().slice(0, 8);
    let prisma: PrismaService;
    let service: BuyerMergeService;
    const accounts: string[] = [];
    const requests: string[] = [];

    const account = async (tag: string) => {
      const a = await prisma.buyerAccount.create({
        data: {
          email: `qa-merge-${tag}-${run}-${randomUUID().slice(0, 4)}@example.test`,
          passwordHash: "x",
          name: `QA ${tag}`,
        } as never,
      });
      accounts.push(a.id);
      return a.id;
    };
    const pendingReview = async () => {
      const primaryAccountId = await account("p");
      const secondaryAccountId = await account("s");
      const r = await prisma.buyerMergeRequest.create({
        data: {
          primaryAccountId,
          secondaryAccountId,
          status: BuyerMergeRequestStatus.PENDING_REVIEW,
          initiatedBy: "BUYER",
        } as never,
      });
      requests.push(r.id);
      return { id: r.id, secondaryAccountId };
    };
    const decided = (results: PromiseSettledResult<unknown>[]) => ({
      won: results.filter((r) => r.status === "fulfilled").length,
      lost: results.filter((r) => r.status === "rejected") as PromiseRejectedResult[],
    });

    beforeAll(async () => {
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      const email = new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) });
      const apple = { revokeRefreshToken: jest.fn().mockResolvedValue(undefined) };
      service = new BuyerMergeService(prisma, email as never, apple as never);
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.buyerMergeRequest.deleteMany({ where: { id: { in: requests } } });
        await prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId: { in: accounts } } });
        await prisma.buyerAccount.updateMany({
          where: { id: { in: accounts } },
          data: { mergedIntoId: null },
        });
        await prisma.buyerAccount.deleteMany({ where: { id: { in: accounts } } });
        await prisma.$disconnect();
      }
    });

    // A race can be won by timing; repeat so a missing CAS shows up red, not by luck.
    const ROUNDS = 5;

    it("two concurrent executes of ONE request: exactly one wins, the other is a 409 MERGE_ALREADY_DECIDED", async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const req = await pendingReview();
        const { won, lost } = decided(
          await Promise.allSettled([service.executeMerge(req.id), service.executeMerge(req.id)]),
        );
        expect(won).toBe(1);
        expect(lost).toHaveLength(1);
        expect(lost[0].reason).toBeInstanceOf(ConflictException);
        expect((lost[0].reason as ConflictException).getResponse()).toMatchObject({
          code: "MERGE_ALREADY_DECIDED",
        });
        const row = await prisma.buyerMergeRequest.findUniqueOrThrow({ where: { id: req.id } });
        expect(row.status).toBe(BuyerMergeRequestStatus.COMPLETED);
      }
    }, 120_000);

    it("execute racing reject: exactly one wins and the outcome is consistent (never merged-and-rejected)", async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const req = await pendingReview();
        const { won, lost } = decided(
          await Promise.allSettled([
            service.executeMerge(req.id),
            service.rejectMerge(req.id, "race"),
          ]),
        );
        expect(won).toBe(1);
        expect(lost).toHaveLength(1);
        expect((lost[0].reason as ConflictException).getResponse?.()).toMatchObject({
          code: "MERGE_ALREADY_DECIDED",
        });
        const row = await prisma.buyerMergeRequest.findUniqueOrThrow({ where: { id: req.id } });
        const secondary = await prisma.buyerAccount.findUniqueOrThrow({
          where: { id: req.secondaryAccountId },
        });
        if (row.status === BuyerMergeRequestStatus.REJECTED) {
          expect(secondary.status).not.toBe("DELETED"); // a rejected request never merged the secondary
          expect(row.completedAt).toBeNull();
        } else {
          expect(row.status).toBe(BuyerMergeRequestStatus.COMPLETED);
          expect(secondary.status).toBe("DELETED");
          expect(row.rejectedAt).toBeNull();
        }
      }
    }, 120_000);

    it("a decided request is refused cleanly afterwards (no second apply)", async () => {
      const req = await pendingReview();
      await service.executeMerge(req.id);
      await expect(service.rejectMerge(req.id)).rejects.toBeDefined();
      await expect(service.executeMerge(req.id)).rejects.toBeDefined();
      const row = await prisma.buyerMergeRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe(BuyerMergeRequestStatus.COMPLETED);
    }, 60_000);
  },
);
