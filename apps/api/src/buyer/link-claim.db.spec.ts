/**
 * Account links are consumed by an atomic claim — real Postgres. Two callers racing on the same
 * link (`Promise.all`, separate pooled connections): exactly one wins, the other gets the generic
 * refusal and writes nothing. Covers the staff reset link, the buyer reset link, and the invite
 * link accepted through the portal and through the Google sign-in path at the same time.
 *
 * Real PrismaClient and the real services; stand-ins only for the mailer, JWT and gateway, which
 * none of these paths touch. Throwaway `qa-*` tenant (assertTestTenant). DB lane: run through
 * `npm run local:test:db`. WRITTEN, NOT RUN by its author (NEED-DB).
 */
import { createHash, randomUUID } from "crypto";
import { PrismaClient, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AuthService } from "../auth/auth.service";
import { GoogleOAuthService } from "../auth/google-oauth.service";
import { BuyerAuthService } from "./buyer-auth.service";
import { BuyerService } from "./buyer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "link-claim.db.spec.ts";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

describeDb("account links are claimed atomically (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let staffAuth: AuthService;
  let buyerAuth: BuyerAuthService;
  let buyers: BuyerService;
  let google: GoogleOAuthService;
  let tenantId: string;
  const run = randomUUID().slice(0, 8);
  const buyerIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const jwtConfig = {
      secret: "qa-link-claim-secret-0123456789-abcdefghijklmnop",
      refreshSecret: "rs",
      expiresIn: "15m",
      refreshExpiresIn: "30d",
    };
    const config = { get: (k: string) => (k === "jwt" ? jwtConfig : undefined) } as any;
    const jwt = { sign: jest.fn().mockReturnValue("tok"), decode: jest.fn() } as any;
    const email = { send: jest.fn().mockResolvedValue({ delivered: true }) } as any;
    const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) } as any;

    staffAuth = new AuthService(prisma as any, {} as any, jwt, config, email, entitlements);
    buyerAuth = new BuyerAuthService(prisma as any, jwt, config, email, {} as any);
    buyers = new BuyerService(prisma as any, email, config, {} as any);
    google = new GoogleOAuthService(prisma as any, jwt, config, email, entitlements);

    const slug = assertTestTenant(`qa-link-claim-${run}`, FILE);
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, status: TenantStatus.ACTIVE },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    // Best-effort: remove exactly what this run created, never masking a test result.
    try {
      await prisma.customerLink.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId: { in: buyerIds } } });
      await prisma.buyerAccount.deleteMany({ where: { id: { in: buyerIds } } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  async function makeBuyer(tag: string) {
    const b = await prisma.buyerAccount.create({
      data: {
        email: `buyer-${tag}-${run}@example.test`,
        passwordHash: "old-hash",
        passwordSet: false,
        name: `QA Buyer ${tag}`,
        status: "ACTIVE",
      },
    });
    buyerIds.push(b.id);
    return b;
  }

  it("a staff reset link raced by two callers: exactly one succeeds, the other is refused", async () => {
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: `staff-${run}@example.test`,
        username: `staff_${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        password: "old-hash",
      },
    });
    userIds.push(user.id);
    const raw = `staff-reset-${run}`.padEnd(64, "x");
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 600_000) },
    });

    const results = await Promise.allSettled([
      staffAuth.resetPassword(raw, "FirstPass1!"),
      staffAuth.resetPassword(raw, "SecondPass2!"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BadRequestException);
    const token = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: sha256(raw) },
    });
    expect(token.usedAt).not.toBeNull();
  });

  it("a staff reset for an account that is no longer active is refused and the link stays unused", async () => {
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: `staff-off-${run}@example.test`,
        username: `staff_off_${run}`,
        role: "OPERATOR",
        status: "INACTIVE",
        password: "old-hash",
      },
    });
    userIds.push(user.id);
    const raw = `staff-off-${run}`.padEnd(64, "x");
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 600_000) },
    });

    await expect(staffAuth.resetPassword(raw, "FirstPass1!")).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const token = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: sha256(raw) },
    });
    expect(token.usedAt).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password).toBe(
      "old-hash",
    );
  });

  it("a buyer reset link raced by two callers: exactly one succeeds, the other is refused", async () => {
    const buyer = await makeBuyer("reset");
    const raw = `buyer-reset-${run}`.padEnd(64, "x");
    await prisma.buyerPasswordResetToken.create({
      data: {
        buyerAccountId: buyer.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const results = await Promise.allSettled([
      buyerAuth.resetPassword(raw, "FirstPass1!"),
      buyerAuth.resetPassword(raw, "SecondPass2!"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BadRequestException);
    const after = await prisma.buyerAccount.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(after.passwordSet).toBe(true);
  });

  async function makeInvite(tag: string) {
    const userId = (
      await prisma.user.create({
        data: {
          tenantId,
          email: `inv-${tag}-${run}@example.test`,
          username: `inv_${tag}_${run}`,
          role: "CUSTOMER",
          status: "ACTIVE",
        },
      })
    ).id;
    userIds.push(userId);
    const customer = await prisma.customer.create({
      data: { tenantId, userId, businessName: `QA ${tag}`, contactName: `QA ${tag}` },
    });
    const token = `invite-${tag}-${run}`;
    const link = await prisma.customerLink.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "INVITED",
        inviteToken: token,
        inviteExpiresAt: new Date(Date.now() + 3_600_000),
        inviteMethod: "EMAIL",
      },
    });
    return { link, token };
  }

  it("two portal accepts of one invite: exactly one connects", async () => {
    const { link, token } = await makeInvite("web");
    const a = await makeBuyer("web-a");
    const b = await makeBuyer("web-b");

    const results = await Promise.allSettled([
      buyers.acceptInvite(token, a.id),
      buyers.acceptInvite(token, b.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(NotFoundException);
    const after = await prisma.customerLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(after).toMatchObject({ status: "ACTIVE", inviteToken: null });
    expect([a.id, b.id]).toContain(after.buyerAccountId);
  });

  it("a portal accept racing a Google accept of one invite: exactly one connects", async () => {
    const { link, token } = await makeInvite("mix");
    const web = await makeBuyer("mix-web");
    const goog = await makeBuyer("mix-google");

    const [webResult] = await Promise.allSettled([
      buyers.acceptInvite(token, web.id),
      (google as any).acceptInviteToken(token, goog.id),
    ]);

    const after = await prisma.customerLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(after).toMatchObject({ status: "ACTIVE", inviteToken: null });
    expect(after.buyerAccountId).toBe(webResult.status === "fulfilled" ? web.id : goog.id);
  });
});
