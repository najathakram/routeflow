/**
 * Buyer merge-verify consume is a real compare-and-set: two concurrent POST verify-merge consumes of
 * the SAME emailed token must yield exactly one success and one NotFound (404). Whether the loser is
 * stopped by the token lookup (winner already committed) or by the CAS `updateMany` (both read the row
 * first), the outcome is identical, so the assertions are on the OUTCOME, never a timing: the request
 * ends PENDING_REVIEW with the token cleared and `verifiedAt` set by exactly one writer.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * `requireLocalDatabaseUrl()` refuses any non-local host. BuyerAccount / BuyerMergeRequest are not
 * tenant-scoped tables, so there is no tenant: the fixtures are two `buyer-cas-<run>-*@example.test`
 * accounts and one merge request, and `afterAll` deletes exactly the rows this run created.
 */
import { randomBytes, randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaClient, BuyerMergeRequestStatus, MergeInitiator } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { BuyerMergeService } from "./buyer-merge.service";

describeDb("buyer merge-verify consume is compare-and-set — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let svc: BuyerMergeService;
  const run = randomUUID().slice(0, 8);
  const accountIds: string[] = [];
  const requestIds: string[] = [];

  const newAccount = async (tag: string) => {
    const a = await raw.buyerAccount.create({
      data: {
        email: `buyer-cas-${run}-${tag}@example.test`,
        passwordHash: "x",
        name: `Cas ${tag}`,
      },
    });
    accountIds.push(a.id);
    return a.id;
  };

  const newRequest = async (over: { verificationExpires?: Date } = {}) => {
    const token = randomBytes(32).toString("hex");
    const primary = await newAccount(`p${requestIds.length}`);
    const secondary = await newAccount(`s${requestIds.length}`);
    const r = await raw.buyerMergeRequest.create({
      data: {
        primaryAccountId: primary,
        secondaryAccountId: secondary,
        initiatedBy: MergeInitiator.BUYER,
        status: BuyerMergeRequestStatus.PENDING_VERIFICATION,
        verificationToken: token,
        verificationExpires: over.verificationExpires ?? new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    requestIds.push(r.id);
    return { id: r.id, token };
  };

  const settle = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    svc = new BuyerMergeService(prisma, {} as any, {} as any);
  }, 120_000);

  afterAll(async () => {
    try {
      await raw.buyerMergeRequest.deleteMany({ where: { id: { in: requestIds } } });
      await raw.buyerAccount.deleteMany({ where: { id: { in: accountIds } } });
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("two concurrent consumes of the same token: exactly one success, one NotFound", async () => {
    const { id, token } = await newRequest();

    const results = await Promise.all([
      settle(svc.verifyMergeToken(token)),
      settle(svc.verifyMergeToken(token)),
    ]);

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const err = (losses[0] as { error: unknown }).error;
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);

    const row = await raw.buyerMergeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(BuyerMergeRequestStatus.PENDING_REVIEW);
    expect(row.verifiedAt).toBeInstanceOf(Date); // set once, by the single winner
    expect(row.verificationToken).toBeNull();
    expect(row.verificationExpires).toBeNull();
  }, 120_000);

  it("a replay after the winner committed is NotFound and leaves verifiedAt unchanged", async () => {
    const { id, token } = await newRequest();
    await svc.verifyMergeToken(token);
    const first = await raw.buyerMergeRequest.findUniqueOrThrow({ where: { id } });

    await expect(svc.verifyMergeToken(token)).rejects.toBeInstanceOf(NotFoundException);

    const after = await raw.buyerMergeRequest.findUniqueOrThrow({ where: { id } });
    expect(after.verifiedAt?.getTime()).toBe(first.verifiedAt?.getTime());
    expect(after.status).toBe(BuyerMergeRequestStatus.PENDING_REVIEW);
  }, 120_000);
});
